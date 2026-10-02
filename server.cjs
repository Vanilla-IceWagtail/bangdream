/*!
 * 合成邦多利皇帝 · 本地静态服务器（可选，但推荐）
 *
 * 为什么需要它：直接用 file:// 双击打开 index.html 时，部分浏览器（尤其 Firefox）
 * 不允许网页保存数据，导入的玩偶贴图和排行榜就存不下来。
 * 用这个小服务器打开，一切数据都会正常保存。
 *
 * 用法：双击「启动游戏.cmd」，或在这个目录下执行
 *   node server.cjs
 * 然后浏览器会自动打开 http://127.0.0.1:5173
 *
 * 多人同榜（局域网）：
 *   node server.cjs --lan              监听 0.0.0.0，同一个 Wi-Fi 下的人用你的地址打开，成绩进同一张榜
 *   node server.cjs --port 5180        换一个起始端口（也可以用环境变量 PORT）
 *   node server.cjs --lan --port 5180  两个一起用
 *
 * 成绩存在 data/scores.json（目录不存在会自动创建），接口：
 *   GET  /api/scores   读整张榜
 *   GET  /api/health   探活
 *   POST /api/scores   提交一条或一批成绩（同一 id 只记一次）
 *
 * 所有 /api/* 响应都带 CORS 头，OPTIONS 返回 204。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const START_PORT = Number(process.env.PORT) || 5173;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2'
};

/* ---------------- 排行榜数据 ---------------- */

const MAX_ENTRIES = 100; // 榜单只留前 100 名
const MAX_BATCH = 50; // 一次 POST 最多 50 条
const MAX_BODY = 256 * 1024; // 超过 256 KB 的请求体直接 413
const RANGE = {
  score: [0, 99999999],
  maxTier: [1, 11],
  merges: [0, 100000],
  durationMs: [0, 86400000],
  difficulty: [1, 10]
};
const PLAYER_MAX = 24;
const EMPTY = () => ({ updatedAt: 0, entries: [] });

// data 目录可以用环境变量 SUIKA_DATA 覆盖（测试用临时目录）
let DATA_DIR = process.env.SUIKA_DATA ? path.resolve(process.env.SUIKA_DATA) : path.join(ROOT, 'data');
let DATA_FILE = path.join(DATA_DIR, 'scores.json'); // 兼容旧引用，实际以 dataFilePath() 为准

function dataFilePath() {
  return path.join(DATA_DIR, 'scores.json');
}

// 写盘串行队列：所有 saveScores 排在同一条 Promise 链上，避免同时写同一个文件
let writeChain = Promise.resolve();

/*
 * 读改写也得排队：如果多个请求同时「读榜单 → 合并 → 写回」，
 * 后读到的还是旧数据，最后写的那次会把别人的成绩覆盖掉
 * （多人同时提交时就会丢成绩）。所以整个「读-合并-写」放进同一条串行链。
 */
let updateChain = Promise.resolve();

function enqueueUpdate(fn) {
  const task = updateChain.then(fn, fn);
  updateChain = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

function clampInt(v, lo, hi, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function pickString(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * 校验并规整一条成绩。合法返回规整后的对象，非法返回 null。
 * 数值字段非法（字符串、NaN）整条丢弃；超范围夹到边界。
 * player 超长按 24 截断；difficulty=99 夹到 10；maxTier=0 夹到 1。
 */
function normalizeEntry(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = pickString(raw.id, 64) || pickString(raw.roundId, 64);
  if (!id) return null;

  const score = typeof raw.score === 'number' ? raw.score : Number(raw.score);
  if (!Number.isFinite(score)) return null;
  const scoreInt = Math.trunc(score);
  if (scoreInt < RANGE.score[0] || scoreInt > RANGE.score[1]) return null;

  const at = typeof raw.at === 'number' ? raw.at : Number(raw.at);
  const stamp = Number.isFinite(at) && at > 0 ? Math.trunc(at) : now;

  return {
    id,
    player: pickString(raw.player, PLAYER_MAX) || '玩家',
    score: scoreInt,
    maxTier: clampInt(raw.maxTier, RANGE.maxTier[0], RANGE.maxTier[1], 1),
    merges: clampInt(raw.merges, RANGE.merges[0], RANGE.merges[1], 0),
    durationMs: clampInt(raw.durationMs, RANGE.durationMs[0], RANGE.durationMs[1], 0),
    difficulty: clampInt(raw.difficulty, RANGE.difficulty[0], RANGE.difficulty[1], 5),
    at: stamp
  };
}

/** 排序：分数降序 → 最高级降序 → 时间升序（先到的在前） */
function sortEntries(list) {
  return list.slice().sort((a, b) => b.score - a.score || b.maxTier - a.maxTier || a.at - b.at);
}

/**
 * 把 incoming 并进 list：同 id 只保留一条（老的赢）。
 * 返回 { entries, accepted, duplicated, acceptedIds }，acceptedIds 是本次真正写进去的 id。
 */
function mergeEntries(list, incoming) {
  const seen = new Set();
  const entries = [];
  for (const e of list) {
    if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
    seen.add(e.id);
    entries.push(e);
  }
  let accepted = 0;
  let duplicated = 0;
  const acceptedIds = [];
  for (const e of incoming) {
    if (!e || typeof e.id !== 'string') continue;
    if (seen.has(e.id)) {
      duplicated += 1;
      continue;
    }
    seen.add(e.id);
    entries.push(e);
    accepted += 1;
    acceptedIds.push(e.id);
  }
  const sorted = sortEntries(entries).slice(0, MAX_ENTRIES);
  return { entries: sorted, accepted, duplicated, acceptedIds };
}

/** 某个 id 在榜上的名次（1 起）；不在榜上返回 null */
function rankOf(entries, id) {
  if (!id) return null;
  const i = entries.findIndex((e) => e && e.id === id);
  return i < 0 ? null : i + 1;
}

function normalizeScores(raw) {
  const entries = [];
  for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
    const n = normalizeEntry(e, 0);
    if (n) entries.push(n);
  }
  return { updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0, entries: sortEntries(entries).slice(0, MAX_ENTRIES) };
}

/** 读榜单。文件不存在 / 读不动 / 内容是垃圾，一律当空榜单，绝不抛错。 */
function loadScores() {
  let text;
  try {
    text = fs.readFileSync(dataFilePath(), 'utf8');
  } catch (e) {
    return EMPTY();
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY();
    return normalizeScores(parsed);
  } catch (e) {
    return EMPTY();
  }
}

/** 写榜单：先写临时文件再 rename，中途断电也不会留下半截 JSON。串行队列保证不互相踩。 */
function saveScores(data) {
  const payload = JSON.stringify({
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : Date.now(),
    entries: sortEntries(Array.isArray(data.entries) ? data.entries : []).slice(0, MAX_ENTRIES)
  });
  const task = writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        const file = dataFilePath();
        const tmp = path.join(DATA_DIR, `scores.json.${process.pid}.${Date.now()}.tmp`);
        fs.mkdir(DATA_DIR, { recursive: true }, (mkErr) => {
          if (mkErr) return reject(mkErr);
          fs.writeFile(tmp, payload, 'utf8', (wErr) => {
            if (wErr) return reject(wErr);
            fs.rename(tmp, file, (rErr) => (rErr ? reject(rErr) : resolve()));
          });
        });
      })
  );
  // 队列本身不能因为一次失败就断掉
  writeChain = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

/* ---------------- HTTP ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function sendJson(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...(extra || {}),
    ...CORS
  });
  res.end(body);
}

function sendApiError(res, code, error) {
  sendJson(res, code, { ok: false, error });
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        finish({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ error: true }));
  });
}

async function handleApi(req, res, urlPath) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const known = urlPath === '/api/scores' || urlPath === '/api/health';
  if (!known) return sendApiError(res, 404, 'not-found');

  if (req.method === 'GET' || req.method === 'HEAD') {
    const data = loadScores();
    if (urlPath === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'suika-scores', updatedAt: data.updatedAt, count: data.entries.length });
    }
    return sendJson(res, 200, { ok: true, updatedAt: data.updatedAt, count: data.entries.length, entries: data.entries });
  }

  if (urlPath === '/api/health') return sendApiError(res, 405, 'method-not-allowed');
  if (req.method !== 'POST') return sendApiError(res, 405, 'method-not-allowed');

  const body = await readBody(req, MAX_BODY);
  if (body.tooLarge) return sendApiError(res, 413, 'too-large');
  if (body.error) return sendApiError(res, 400, 'bad-json');

  let parsed;
  try {
    parsed = JSON.parse(body.body);
  } catch (e) {
    return sendApiError(res, 400, 'bad-json');
  }
  if (!parsed || typeof parsed !== 'object') return sendApiError(res, 400, 'bad-json');

  const now = Date.now();
  const incoming = [];
  let rejected = 0;
  const take = (item) => {
    const n = normalizeEntry(item, now);
    if (n) incoming.push(n);
    else rejected += 1;
  };

  if (Array.isArray(parsed)) {
    if (!parsed.length) return sendApiError(res, 400, 'no-entries');
    for (const item of parsed.slice(0, MAX_BATCH)) take(item);
    rejected += Math.max(0, parsed.length - MAX_BATCH);
  } else if (Array.isArray(parsed.entries)) {
    if (!parsed.entries.length) return sendApiError(res, 400, 'no-entries');
    for (const item of parsed.entries.slice(0, MAX_BATCH)) take(item);
    rejected += Math.max(0, parsed.entries.length - MAX_BATCH);
  } else {
    take(parsed); // 允许直接 POST 单条 entry
  }

  if (!incoming.length) return sendApiError(res, 400, rejected ? 'invalid-entry' : 'no-entries');

  let result;
  try {
    // 整个「读 - 合并 - 写」串行执行，避免并发提交互相覆盖
    result = await enqueueUpdate(async () => {
      const before = loadScores();
      const merged = mergeEntries(before.entries, incoming);
      const latest = merged.entries;
      if (merged.accepted > 0) {
        await saveScores({ updatedAt: now, entries: latest });
      }
      return { merged, latest };
    });
  } catch (e) {
    console.error('[suika] 排行榜写入失败：', e.message);
    return sendApiError(res, 500, 'write-failed');
  }
  const merged = result.merged;
  const latest = result.latest;

  // 名次只看「这次真正写进去的」条目；一条都没写就是 null
  let rank = null;
  for (const id of merged.acceptedIds) {
    const r = rankOf(latest, id);
    if (r !== null && (rank === null || r < rank)) rank = r;
  }

  return sendJson(res, 200, {
    ok: true,
    accepted: merged.accepted,
    duplicated: merged.duplicated,
    rejected,
    rank,
    updatedAt: now,
    count: latest.length,
    entries: latest
  });
}

function createServer() {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (e) {
      return send(res, 400, 'bad request');
    }

    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      return handleApi(req, res, urlPath).catch((e) => {
        console.error('[suika] 接口出错：', e.message);
        if (!res.headersSent) sendApiError(res, 500, 'server-error');
        else res.end();
      });
    }
    if (urlPath === '/' || urlPath.endsWith('/')) urlPath += 'index.html';

    const target = path.join(ROOT, urlPath);
    // 防目录穿越：只允许访问本目录内的文件
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return send(res, 403, 'forbidden');

    fs.readFile(target, (err, data) => {
      if (err) return send(res, 404, '404 not found: ' + urlPath);
      send(res, 200, data, MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
    });
  });
}

/* ---------------- 启动（只有直接运行本文件时才执行） ---------------- */

function parseArgs(argv) {
  const out = { lan: false, port: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan') {
      out.lan = true;
    } else if (a === '--port') {
      const v = argv[i + 1];
      i += 1;
      if (!/^\d+$/.test(String(v == null ? '' : v))) out.error = '--port 后面要跟一个端口号，比如 --port 5180';
      else out.port = Number(v);
    } else if (a.startsWith('--port=')) {
      const v = a.slice('--port='.length);
      if (!/^\d+$/.test(v)) out.error = '--port 后面要跟一个端口号，比如 --port 5180';
      else out.port = Number(v);
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      out.error = '不认识的参数：' + a;
    }
  }
  return out;
}

function lanAddresses(port) {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const info of nets[name] || []) {
      const family = typeof info.family === 'string' ? info.family : info.family === 4 ? 'IPv4' : '';
      if (family !== 'IPv4' || info.internal) continue;
      out.push({ name, address: info.address, url: `http://${info.address}:${port}/` });
    }
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node server.cjs [--lan] [--port <端口>]');
    console.log('  --lan           同时允许局域网内的其他人访问（成绩进同一张榜单）');
    console.log('  --port <端口>   指定起始端口，默认 5173（也可以用环境变量 PORT）');
    console.log('  没参数时和以前一样，只监听本机 127.0.0.1。');
  } else if (args.error) {
    console.error('[suika] ' + args.error);
    console.error('   用法：node server.cjs [--lan] [--port <端口>]');
    process.exitCode = 1;
  } else {
    const server = createServer();
    const host = args.lan ? '0.0.0.0' : '127.0.0.1';
    const startPort = args.port == null ? START_PORT : args.port;
    let port = startPort;

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < startPort + 20) {
        port += 1;
        server.listen(port, host);
      } else {
        console.error('[suika] 启动失败：', err.message);
        process.exitCode = 1;
      }
    });

    server.listen(port, host, () => {
      const localUrl = `http://127.0.0.1:${port}/`;
      console.log('🍉 合成邦多利皇帝已启动：' + localUrl);
      console.log('   关掉这个窗口就是关掉服务器。');
      if (args.lan) {
        console.log('   当前是局域网模式，同一个网络里的其他人可以打开下面的地址一起玩：');
        const list = lanAddresses(port);
        if (list.length) for (const n of list) console.log('     ' + n.url + '   （' + n.name + '）');
        else console.log('     （没找到局域网 IPv4 地址，可能没连上 Wi-Fi 或有线网）');
        console.log('   大家用这个地址打开，成绩就会进同一张排行榜。');
        console.log('   ⚠ 只建议在可信网络（比如自己家）下这么用：同一个网络里的人都能改这份成绩单。');
      }
      if (!process.env.SUIKA_NO_OPEN) exec(`start "" "${localUrl}"`, () => {});
    });
  }
}

module.exports = {
  createServer,
  loadScores,
  saveScores,
  normalizeEntry,
  normalizeScores,
  sortEntries,
  mergeEntries,
  rankOf,
  parseArgs,
  lanAddresses,
  DATA_DIR,
  DATA_FILE,
  dataFilePath,
  MAX_ENTRIES,
  MAX_BATCH,
  MAX_BODY,
  START_PORT,
  ROOT
};

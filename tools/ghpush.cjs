/*!
 * 合成大西瓜 · 用 GitHub REST API 推送（本网络 github.com:443 不通、只有 api.github.com 通）
 *
 * 为什么需要它：`git push` 走的是 github.com/codeload，本网络连不上（代理没开）；
 * 而 api.github.com 是通的（`gh api` 正常）。所以这里用 Git Data API 自己拼一个 commit：
 *   1. 算本地每个文件的 git blob sha（sha1("blob <len>\0" + content)）
 *   2. 拉远端那棵树，比对出真正有变化的文件（没变的不用重传）
 *   3. 逐个上传 blob → 建 tree（base_tree = 旧树）→ 建 commit → 移动分支引用
 *
 * 用法：
 *   node tools/ghpush.cjs --repo <owner/name> --dir <本地目录> [--branch main] [--message "..."]
 *                          [--create] [--pages]
 * 令牌从环境变量 GH_TOKEN 读（PowerShell: $env:GH_TOKEN = gh auth token）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.github.com';

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const o = { branch: 'main', message: 'chore: 更新', create: false, pages: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = argv[++i];
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--branch') o.branch = argv[++i];
    else if (a === '--message') o.message = argv[++i];
    else if (a === '--create') o.create = true;
    else if (a === '--pages') o.pages = true;
    else if (a === '--dry') o.dry = true;
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!opts.repo || !opts.dir || !TOKEN) {
  console.log('用法：node tools/ghpush.cjs --repo owner/name --dir <目录> [--branch main] [--message "..."] [--create] [--pages]');
  console.log('需要环境变量 GH_TOKEN（$env:GH_TOKEN = gh auth token）');
  process.exit(1);
}

/* ---------------- HTTP ---------------- */

async function api(method, url, body, tries) {
  const maxTries = tries || 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await apiOnce(method, url, body);
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || e.status >= 500 || e.status === 429;
      if (!retryable || attempt === maxTries) throw e;
      const wait = 800 * attempt;
      console.log('    （' + (e.status || '网络') + ' 失败，' + wait + 'ms 后重试 ' + attempt + '/' + (maxTries - 1) + '）');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function apiOnce(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method: method,
    headers: {
      authorization: 'Bearer ' + TOKEN,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'suika-ghpush',
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = text;
  }
  if (!res.ok) {
    const msg = json && json.message ? json.message : String(json).slice(0, 200);
    const err = new Error(method + ' ' + url + ' → ' + res.status + ' ' + msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/* ---------------- 本地文件 → git blob ---------------- */

const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const { execFileSync } = require('child_process');

/** 优先用 git 的文件清单（这样 .gitignore 自动生效，推送内容 = 本地 commit 内容） */
function listFromGit(dir) {
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { maxBuffer: 1 << 30 });
  let out;
  try {
    out = run(['ls-tree', '-r', '-z', 'HEAD']);
  } catch (e) {
    return null; // 不是 git 仓库 / 还没有 commit
  }
  const files = [];
  out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .forEach((line) => {
      const tab = line.indexOf('\t');
      if (tab < 0) return;
      const meta = line.slice(0, tab).split(/\s+/);
      const p = line.slice(tab + 1);
      if (meta[1] !== 'blob') return; // 跳过子模块/软链
      const full = path.join(dir, p);
      if (!fs.existsSync(full)) return;
      const buf = fs.readFileSync(full);
      files.push({ path: p, size: buf.length, sha: meta[2], content: buf });
    });
  return files;
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.nojekyll') continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), base, out);
    } else {
      if (SKIP_FILES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      const buf = fs.readFileSync(full);
      out.push({
        path: rel,
        size: buf.length,
        sha: crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex'),
        content: buf
      });
    }
  }
}

/* ---------------- 主流程 ---------------- */

async function ensureRepo() {
  try {
    return await api('GET', '/repos/' + opts.repo);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (!opts.create) throw new Error('仓库不存在，且没加 --create：' + opts.repo);
  const [owner, name] = opts.repo.split('/');
  const me = await api('GET', '/user');
  const isMine = me.login.toLowerCase() === owner.toLowerCase();
  console.log('  创建仓库 ' + opts.repo + (isMine ? '（public）' : ''));
  return await api('POST', isMine ? '/user/repos' : '/orgs/' + owner + '/repos', {
    name: name,
    private: false,
    auto_init: false,
    description: '合成大西瓜 · 玩偶版（BanG Dream! 毛绒玩偶 + 轮廓碰撞 + 果冻手感）'
  });
}

async function main() {
  console.log('目标仓库：' + opts.repo + '  分支：' + opts.branch);
  const repo = await ensureRepo();
  console.log('  默认分支：' + (repo.default_branch || '(空仓库)'));

  // 远端当前引用 + 树
  let parentSha = null;
  let baseTree = null;
  let remoteTree = new Map();
  try {
    const ref = await api('GET', '/repos/' + opts.repo + '/git/ref/heads/' + opts.branch);
    parentSha = ref.object.sha;
    const commit = await api('GET', '/repos/' + opts.repo + '/git/commits/' + parentSha);
    baseTree = commit.tree.sha;
    const tree = await api('GET', '/repos/' + opts.repo + '/git/trees/' + baseTree + '?recursive=1');
    tree.tree.forEach((t) => {
      if (t.type === 'blob') remoteTree.set(t.path, t.sha);
    });
    console.log('  远端 HEAD：' + parentSha.slice(0, 7) + '（' + remoteTree.size + ' 个文件）');
  } catch (e) {
    // 404 = 没有这个分支；409 = 仓库还是空的（Git Repository is empty）
    if (e.status !== 404 && e.status !== 409) throw e;
    console.log('  远端还没有 ' + opts.branch + ' 分支（首次推送）');
  }

  // 本地文件（优先用 git 清单，.gitignore 自动生效）
  let files = listFromGit(opts.dir);
  if (files) {
    console.log('  本地文件：' + files.length + ' 个（取自 git HEAD），共 ' + (files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1) + ' MB');
  } else {
    files = [];
    walk(opts.dir, opts.dir, files);
    console.log('  本地文件：' + files.length + ' 个（目录扫描，非 git 仓库），共 ' + (files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1) + ' MB');
  }

  // 差异
  const changed = files.filter((f) => remoteTree.get(f.path) !== f.sha);
  const localPaths = new Set(files.map((f) => f.path));
  const deleted = [...remoteTree.keys()].filter((p) => !localPaths.has(p));
  console.log('  需要上传：' + changed.length + ' 个，删除：' + deleted.length + ' 个');
  changed.slice(0, 12).forEach((f) => console.log('    + ' + f.path + '  ' + (f.size / 1024).toFixed(0) + 'KB'));
  if (changed.length > 12) console.log('    … 还有 ' + (changed.length - 12) + ' 个');

  if (opts.dry) {
    console.log('（--dry：只看看，不推送）');
    return;
  }

  // 上传 blob
  const treeEntries = [];
  let done = 0;
  for (const f of changed) {
    let blobSha = f.sha;
    if (f.size > 40) {
      // 大文件（含二进制）用 base64 走 blobs 接口
      const blob = await api('POST', '/repos/' + opts.repo + '/git/blobs', {
        content: f.content.toString('base64'),
        encoding: 'base64'
      });
      blobSha = blob.sha;
    }
    treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blobSha });
    done += 1;
    if (done % 10 === 0) console.log('    已上传 ' + done + '/' + changed.length);
  }
  deleted.forEach((p) => treeEntries.push({ path: p, mode: '100644', type: 'blob', sha: null }));

  // tree → commit → 移动引用
  const tree = await api('POST', '/repos/' + opts.repo + '/git/trees', {
    base_tree: baseTree || undefined,
    tree: treeEntries
  });
  const commitBody = { message: opts.message, tree: tree.sha, parents: parentSha ? [parentSha] : [] };
  const commit = await api('POST', '/repos/' + opts.repo + '/git/commits', commitBody);
  if (parentSha) {
    await api('PATCH', '/repos/' + opts.repo + '/git/refs/heads/' + opts.branch, { sha: commit.sha, force: false });
  } else {
    await api('POST', '/repos/' + opts.repo + '/git/refs', { ref: 'refs/heads/' + opts.branch, sha: commit.sha });
  }
  console.log('  ✔ 已推送 commit ' + commit.sha.slice(0, 7) + ' → ' + opts.branch);

  // Pages
  if (opts.pages) {
    try {
      await api('POST', '/repos/' + opts.repo + '/pages', { source: { branch: opts.branch, path: '/' } });
      console.log('  ✔ 已开启 GitHub Pages');
    } catch (e) {
      if (e.status === 409) console.log('  （Pages 已经开过了）');
      else if (e.status === 422) console.log('  （Pages 已存在或参数被拒：' + (e.body && e.body.message) + '）');
      else throw e;
    }
    const info = await api('GET', '/repos/' + opts.repo + '/pages');
    console.log('  Pages 地址：' + (info.html_url || '(等待构建)'));
  }
}

main().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});

/*!
 * 开源前自查：扫「密码/令牌 / 个人隐私 / 本地绝对路径 / 临时文件 / 测试垃圾 / 不宜公开内容」
 *
 * 扫三处：
 *   1. 当前仓库内容（git 跟踪的文件才算「已公开」）
 *   2. git 历史（删掉过的文件也还在历史里）
 *   3. 工作区里的未跟踪文件（决定要不要加进 .gitignore）
 *
 * 用法：node tools/audit-public.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const git = (args, opts) =>
  execFileSync('git', ['-C', ROOT, ...args], Object.assign({ maxBuffer: 1 << 30 }, opts || {})).toString('utf8');

const TEXT_EXT = /\.(js|cjs|mjs|json|html|css|md|txt|cmd|ps1|yml|yaml|gitignore|nojekyll)$/i;

/* ---------------- 规则 ---------------- */

const RULES = [
  {
    id: 'secret',
    label: '密码 / 令牌 / 密钥',
    re: /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer\s+[A-Za-z0-9._-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i
  },
  {
    id: 'private-key-file',
    label: '私钥/证书文件',
    file: /\.(pem|key|p12|pfx|jks|keystore|asc)$/i
  },
  {
    id: 'privacy',
    label: '个人隐私（真实邮箱/手机号/身份证/住址/微信号）',
    re: /([A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(\b1[3-9]\d{9}\b)|(\b\d{17}[\dXx]\b)|(身份证|手机号|微信号|QQ号|家庭住址)/i
  },
  {
    id: 'abs-path',
    label: '本地绝对路径',
    re: /([A-Za-z]:\\{1,2}Users\\{1,2}[^\\/\s"')]+|\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|C:\/Users\/)/i
  },
  {
    id: 'temp-file',
    label: '临时/备份文件',
    file: /(\.bak$|\.tmp$|\.temp$|~$|\.orig$|\.rej$|\.swp$|Thumbs\.db$|\.DS_Store$|\.log$|\.cache$)/i
  },
  {
    id: 'test-junk',
    label: '调试/测试垃圾文件',
    file: /(^|\/)(_dbg|_t\d|_test|debug-|tmp-|temp-)/i
  },
  {
    id: 'heavy',
    label: '体积异常的文件（>2MB，检查是否该进仓库）',
    heavy: 2 * 1024 * 1024
  }
];

/* 已知且有意为之的内容（在报告里单独说明，不算“意外泄露”） */
const KNOWN = [
  { file: 'assets/qr-donate.jpg', why: '作者的收款码（应作者要求放进来做打赏弹窗；等于公开一张收款码）' },
  { file: 'js/config.js', why: '榜单 KV 地址：客户端本来就要读写它，公开是设计的一部分（但谁都能改那张榜）' },
  { file: 'vendor/matter.min.js', why: '第三方库 matter-js（MIT），按许可能再分发' },
  { file: 'assets/dolls/', why: '45 张 AI 生成的同人娃娃图（角色形象版权属 BanG Dream! 项目方，README 已注明勿商用）' },
  { file: 'preview/', why: '界面截图（README 引用；注意图中若有他人昵称）' }
];

/* ---------------- 扫描 ---------------- */

const findings = [];
const add = (o) => findings.push(o);

function scanText(where, file, text) {
  const lines = text.split('\n');
  RULES.forEach((rule) => {
    if (!rule.re) return;
    lines.forEach((line, i) => {
      const m = line.match(rule.re);
      if (!m) return;
      /* 排除明显的占位/示例写法 */
      if (/example\.com|your[_-]?token|xxx+|placeholder|<token>|测试用|示例/i.test(line)) return;
      /* 自查工具自身必须包含这些"敏感模式"才能检测，跳过自己 */
      if (/tools\/(audit-public|cleanup-public)\.cjs$/.test(file)) return;
      add({ where, rule: rule.label, file, line: i + 1, hit: String(m[0]).slice(0, 80), text: line.trim().slice(0, 110) });
    });
  });
}

function scanTree() {
  const tracked = git(['ls-files']).split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard']).split('\n').filter(Boolean);

  console.log('=== 1) 已跟踪文件（= 已经公开的内容）：' + tracked.length + ' 个 ===');
  tracked.forEach((rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    RULES.forEach((rule) => {
      if (rule.file && rule.file.test(rel)) add({ where: 'tracked', rule: rule.label, file: rel, hit: '(文件名匹配)' });
      if (rule.heavy && st.size > rule.heavy) add({ where: 'tracked', rule: rule.label, file: rel, hit: Math.round(st.size / 1048576) + ' MB' });
    });
    if (TEXT_EXT.test(rel) && st.size < 2 * 1024 * 1024) {
      scanText('tracked', rel, fs.readFileSync(abs, 'utf8'));
    }
  });

  console.log('=== 2) 未跟踪文件（还没公开，但别手滑 add 进去）：' + untracked.length + ' 个 ===');
  untracked.forEach((rel) => {
    add({ where: 'untracked', rule: '未跟踪文件（提交前确认）', file: rel, hit: '' });
  });

  console.log('=== 3) 已被 .gitignore 忽略的文件：' + ignored.length + ' 个（安全）===');
  ignored.slice(0, 20).forEach((rel) => console.log('    · ' + rel));
  if (ignored.length > 20) console.log('    … 还有 ' + (ignored.length - 20) + ' 个');
  return { tracked, untracked, ignored };
}

function scanHistory() {
  console.log('\n=== 4) git 历史（所有提交里出现过的文本文件内容）===');
  let commits = [];
  try {
    commits = git(['rev-list', '--all']).split('\n').filter(Boolean);
  } catch (e) {
    return;
  }
  /* 取每个提交里所有文本 blob 的内容 */
  const seen = new Set();
  commits.forEach((sha) => {
    let files = [];
    try {
      files = git(['ls-tree', '-r', '-z', '--name-only', sha]).split('\0').filter(Boolean);
    } catch (e) {
      return;
    }
    files.forEach((rel) => {
      if (!TEXT_EXT.test(rel)) return;
      if (seen.has(sha + ':' + rel)) return;
      seen.add(sha + ':' + rel);
      let text = '';
      try {
        text = git(['show', sha + ':' + rel]);
      } catch (e) {
        return;
      }
      scanText('history ' + sha.slice(0, 7), rel, text);
    });
  });
  console.log('  扫描了 ' + commits.length + ' 个提交 / ' + seen.size + ' 个文件版本');
}

function scanWorkspace() {
  console.log('\n=== 5) 工作区里体积大 / 像垃圾的文件 ===');
  const walk = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else out.push(full);
    }
  };
  const all = [];
  walk(ROOT, all);
  const big = all.filter((f) => fs.statSync(f).size > 2 * 1024 * 1024).map((f) => ({ f: path.relative(ROOT, f), mb: fs.statSync(f).size / 1048576 }));
  big.sort((a, b) => b.mb - a.mb).forEach((x) => console.log('    ' + x.mb.toFixed(1) + ' MB  ' + x.f));
  const junk = all.filter((f) => RULES.find((r) => r.id === 'temp-file' || r.id === 'test-junk') && /(\.bak$|\.tmp$|~$|Thumbs\.db$|\.DS_Store$|(^|\/)_dbg|(^|\/)_t\d)/i.test(path.relative(ROOT, f)));
  console.log('    工作区文件总数：' + all.length);
  if (junk.length) junk.forEach((f) => console.log('    ⚠ 像垃圾：' + path.relative(ROOT, f)));
  else console.log('    ✔ 没有发现 .bak/.tmp/调试残留 之类的垃圾文件');
}

/* ---------------- 报告 ---------------- */

console.log('项目：' + ROOT + '\n');
scanTree();
scanHistory();
scanWorkspace();

console.log('\n=== 发现 ===');
if (!findings.length) {
  console.log('  ✔ 没有命中任何规则');
} else {
  const groups = {};
  findings.forEach((f) => {
    const k = f.where + ' | ' + f.rule;
    (groups[k] = groups[k] || []).push(f);
  });
  Object.keys(groups).forEach((k) => {
    console.log('\n  【' + k + '】' + groups[k].length + ' 处');
    groups[k].slice(0, 12).forEach((f) => {
      console.log('    ' + f.file + (f.line ? ':' + f.line : '') + '   ' + (f.hit || ''));
      if (f.text && !f.text.startsWith('//')) console.log('        ' + f.text);
    });
    if (groups[k].length > 12) console.log('    … 还有 ' + (groups[k].length - 12) + ' 处');
  });
}

console.log('\n=== 已知且有意为之（不算意外泄露，但你要知道它们是公开的）===');
KNOWN.forEach((k) => {
  const exists = fs.existsSync(path.join(ROOT, k.file));
  console.log('  ' + (exists ? '·' : '×') + ' ' + k.file + '  —— ' + k.why);
});

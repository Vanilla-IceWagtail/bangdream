/*!
 * 改名：把项目名从旧名换成新名（默认：合成邦多利皇帝）
 * （用 Node 做，避免 PowerShell 传中文被编码破坏；ASCII 源码 + 中文当数据）
 *
 * 用法：node tools/rename-project.cjs "旧名" "新名"
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OLD = process.argv[2] || '旧名字';
const NEW = process.argv[3] || '合成邦多利皇帝';
const OLD_SHORT = OLD.replace(/[！!]+$/, '');
const NEW_SHORT = NEW.replace(/[！!]+$/, '');

const TEXT = /\.(md|html|js|cjs|mjs|cmd|css|json|txt)$/i;
const SKIP_DIR = /(^|[\\/])(\.git|preview|node_modules)([\\/]|$)/;

let changed = 0;
const log = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (SKIP_DIR.test(full)) continue;
    if (e.isDirectory()) {
      walk(full);
      continue;
    }
    if (!TEXT.test(e.name)) continue;
    const t = fs.readFileSync(full, 'utf8');
    if (!t.includes(OLD_SHORT)) continue;
    let out = t.split(OLD).join(NEW);          // 全称（含感叹号）
    out = out.split(OLD_SHORT).join(NEW_SHORT); // 去掉感叹号后的残留
    if (out !== t) {
      fs.writeFileSync(full, out, 'utf8');
      changed++;
      log.push('  ' + path.relative(ROOT, full));
    }
  }
}

walk(ROOT);
console.log('改名：' + OLD + '  →  ' + NEW);
console.log('改动文件 ' + changed + ' 个：');
log.forEach((l) => console.log(l));

/* 复核：还有没有残留 */
let left = 0;
function check(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (SKIP_DIR.test(full)) continue;
    if (e.isDirectory()) {
      check(full);
      continue;
    }
    if (!TEXT.test(e.name)) continue;
    const t = fs.readFileSync(full, 'utf8');
    if (t.includes(OLD_SHORT)) {
      left++;
      console.log('  ⚠ 仍有残留：' + path.relative(ROOT, full));
    }
  }
}
check(ROOT);
console.log(left === 0 ? '\n✔ 仓库内已无旧名残留' : '\n⚠ 还有 ' + left + ' 个文件残留');

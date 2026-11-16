/**
 * 极简日志：
 *   - 内存环形缓冲（给网页实时看），上限 LOG_MAX 条，默认 500
 *   - 落盘 data/logs/YYYY-MM-DD.log，单文件超过 LOG_FILE_MAX_MB（默认 5MB）轮转成 .1
 *   - 多账号：每条记录带 acct（账号显示名）与 acctId，前端可按账号过滤
 */
const fs = require('fs');
const path = require('path');

const MAX = Math.max(50, Number(process.env.LOG_MAX) || 500);
const FILE_MAX = (Number(process.env.LOG_FILE_MAX_MB) || 5) * 1024 * 1024;
const KEEP_DAYS = Math.max(1, Number(process.env.LOG_KEEP_DAYS) || 30);  // 日志保留天数
const buf = [];

function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}

function bjDay() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function rotate(file) {
  try {
    if (fs.statSync(file).size > FILE_MAX) fs.renameSync(file, `${file}.1`);
  } catch (e) { /* 文件不存在或轮转失败忽略 */ }
}

// 清理超过保留期的历史日志，避免长期运行把磁盘堆满（7×24 场景）
function cleanup(dir) {
  try {
    const cutoff = new Date(Date.now() + 8 * 3600 * 1000 - KEEP_DAYS * 86400 * 1000)
      .toISOString().slice(0, 10);
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^(\d{4}-\d{2}-\d{2})\.log(\.\d+)?$/);
      if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, name));
    }
  } catch (e) { /* 清理失败不影响运行 */ }
}

let lastCleanup = 0;
function write(line, level = 'info', dataDir, meta = {}) {
  const item = { t: Date.now(), time: ts(), level, msg: line, acct: meta.acct || '', acctId: meta.acctId || '' };
  buf.push(item);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  try {
    const dir = path.join(dataDir || path.join(process.cwd(), 'data'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${bjDay()}.log`);
    rotate(file);
    // 每小时清理一次过期日志
    if (Date.now() - lastCleanup > 3600 * 1000) { lastCleanup = Date.now(); cleanup(dir); }
    const tag = item.acct ? ` [${item.acct}]` : '';
    fs.appendFileSync(file, `[${item.time}] [${level}]${tag} ${line}\n`);
  } catch (e) { /* 落盘失败不影响运行 */ }
  const color = { success: '\x1b[32m', warning: '\x1b[33m', error: '\x1b[31m' }[level] || '\x1b[36m';
  const tag = item.acct ? ` \x1b[35m[${item.acct}]\x1b[0m` : '';
  console.log(`${color}[${item.time}] [${level}]\x1b[0m${tag} ${line}`);
}

function recent(limit = 120, acctId = '') {
  const n = Math.min(MAX, Math.max(20, Number(limit) || 120));
  const src = acctId ? buf.filter((x) => x.acctId === acctId) : buf;
  return src.slice(-n);
}

module.exports = { write, recent, MAX };

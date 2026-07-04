/**
 * 简易日志系统 — 记录到文件，按天分文件
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function timestamp() {
  const d = new Date(); // 直接使用本地时间(CST)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function dateStr() {
  const d = new Date(); // 直接使用本地时间(CST)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function logFile() {
  return path.join(LOG_DIR, `${dateStr()}.log`);
}

function write(level, msg) {
  const line = `[${timestamp()}] [${level}] ${msg}\n`;
  fs.appendFileSync(logFile(), line, 'utf-8');
  // 同时输出到控制台
  if (level === 'ERROR') console.error(line.trim());
  else console.log(line.trim());
}

const logger = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
};

module.exports = logger;

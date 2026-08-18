// 远程命令执行器：优先 SSH 密钥认证，无密钥时回退 .env 里的 SERVER_PASS 密码
// 用法：node remote-exec.js "<要在服务器上执行的命令>"
// 依赖：ssh2（缺失时先 npm install ssh2 --no-save，不写入 package.json）
const fs = require('fs');
const os = require('os');
const path = require('path');

let Client;
try {
  ({ Client } = require('ssh2'));
} catch (_) {
  console.error('缺少 ssh2 依赖，请先执行: npm install ssh2 --no-save');
  process.exit(1);
}

const SERVER = { host: '198.13.60.172', port: 22, username: 'root' };

const cmd = process.argv[2];
if (!cmd) {
  console.error('用法: node remote-exec.js "<远程命令>"');
  process.exit(1);
}

// 读本机 SSH 私钥（推荐方式，免密码）
function readKey() {
  try { return fs.readFileSync(path.join(os.homedir(), '.ssh', 'id_ed25519')); } catch (_) { return undefined; }
}

// 回退：从项目根目录 .env 读 SERVER_PASS（.env 已被 gitignore，不会泄露）
function readEnvPass() {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '.env'), 'utf8');
    const m = env.match(/^SERVER_PASS=(.*)$/m);
    return m ? m[1].trim() : undefined;
  } catch (_) { return undefined; }
}

const conn = new Client();
conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('exec 错误:', err.message); conn.end(); process.exit(1); }
    stream.on('data', d => process.stdout.write(d.toString()));
    stream.stderr.on('data', d => process.stderr.write(d.toString()));
    stream.on('close', code => { conn.end(); process.exit(code || 0); });
  });
}).on('error', e => {
  console.error('SSH 连接失败:', e.message);
  process.exit(1);
}).connect({
  ...SERVER,
  privateKey: readKey(),
  password: readEnvPass(),
  readyTimeout: 15000
});

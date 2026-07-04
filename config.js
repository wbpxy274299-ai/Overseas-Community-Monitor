/**
 * DC 发布系统 — 共享配置 (Node.js 版)
 */
const path = require('path');
const fs = require('fs');

// ===== 路径 =====
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'db', 'tasks.db');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const CHANNELS_JSON = path.join(ROOT, 'dc-publish-channels.json');
const ENV_PATH = path.join(ROOT, '.env');

// ===== Discord Bot =====
const PROXY_URL = process.env.HTTP_PROXY || 'http://netproxy.ejoy.com:23198';
const PROXIES = { https: PROXY_URL, http: PROXY_URL };
const DISCORD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 获取代理配置对象（用于 axios）
 * @returns {Object|undefined} axios proxy 配置
 */
function getProxyConfig() {
  if (!PROXY_URL) return undefined;
  
  try {
    const url = new URL(PROXY_URL);
    return {
      protocol: 'http',
      host: url.hostname,
      port: parseInt(url.port)
    };
  } catch (e) {
    console.warn('⚠️ 代理 URL 格式错误:', e.message);
    return undefined;
  }
}

// ===== 扫描间隔 =====
const SCAN_INTERVAL = 1;                  // 扫描间隔（分钟）
const SEND_IMMEDIATE_WINDOW_MIN = 5;      // 定时发送时间窗口（分钟）

// ===== 频道映射（内置副本） =====
const CHANNELS_FALLBACK = {
  '日服-测试频道':        { bot: 'JP',  channel_id: '1412077043759190117' },
  '日服-官方消息频道':    { bot: 'JP',  channel_id: '1244898075135311893' },
  '日服-策划面对面频道':  { bot: 'JP',  channel_id: '1320665511478038608' },
  '日服-公告发布频道':    { bot: 'JP',  channel_id: '1238410997421838389' },
  '繁中服-测试频道':      { bot: 'TC',  channel_id: '1435902837921021962' },
  '繁中服-甜梅爆料所':    { bot: 'TC',  channel_id: '1236864636066725961' },
  '繁中服-重要通告':      { bot: 'TC',  channel_id: '1247850957715275806' },
  '东南亚服-测试频道':    { bot: 'SEA', channel_id: '1514193499363217428' },
  '英-web商城频道':       { bot: 'SEA', channel_id: '1320970432819757066' },
  '越-web商城频道':       { bot: 'SEA', channel_id: '1320738587880325131' },
  '泰-web商城频道':       { bot: 'SEA', channel_id: '1321004965879087134' },
  '英-公告发布频道':      { bot: 'SEA', channel_id: '1250016998721716224' },
  '越-公告发布频道':      { bot: 'SEA', channel_id: '1320737963142942720' },
  '泰-公告发布频道':      { bot: 'SEA', channel_id: '1237222851808071680' },
  '英-日常宣发频道':      { bot: 'SEA', channel_id: '1260136353493024830' },
  '越-日常宣发频道':      { bot: 'SEA', channel_id: '1240917748184383550' },
  '泰-日常宣发频道':      { bot: 'SEA', channel_id: '1240916452463083580' },
  '英-时装宣发频道':      { bot: 'SEA', channel_id: '1240915828724072479' },
  '越-时装宣发频道':      { bot: 'SEA', channel_id: '1240917842023677982' },
  '泰-时装宣发频道':      { bot: 'SEA', channel_id: '1240916568280403989' },
  '韩服-测试频道':        { bot: 'KR',  channel_id: '1508721766606962759' },
  '韩服-版本更新频道':    { bot: 'KR',  channel_id: '1265554715953991804' },
  '韩服-内容发布频道':    { bot: 'KR',  channel_id: '1268424735214145600' },
  '韩服-活动发布频道':    { bot: 'KR',  channel_id: '1268424101962186905' },
};

// ===== 发送人映射 =====
const SERVER_SENDER = { JP: 'メイメイ', TC: '小梅', SEA: 'Mei', KR: '티메이' };

// ===== 状态映射 =====
const STATUS = {
  received: '📝已接收',
  scheduled: '📅已定时',
  sending: '🔄发送中',
  sent: '✅已发送',
  failed: '❌失败',
  timeout: '⏰超时待确认',
  recalled: '🗑️已撤回',
  cancelled: '🚫已取消',
  sent_no_cancel: '⚠️已发送，无法取消，请请求撤回',
};

// ===== 频道加载 =====
function loadChannels() {
  if (fs.existsSync(CHANNELS_JSON)) {
    try {
      const data = JSON.parse(fs.readFileSync(CHANNELS_JSON, 'utf-8'));
      const result = {};
      for (const [name, info] of Object.entries(data.channels || {})) {
        result[name] = { bot: info.bot, channel_id: info.channel_id };
      }
      return result;
    } catch (e) {
      console.warn('⚠️ 加载频道 JSON 失败，使用内置副本:', e.message);
    }
  }
  return CHANNELS_FALLBACK;
}

const CHANNELS = loadChannels();

// ===== 从 .env 读取 Bot Token =====
function getDiscordToken(server) {
  const key = `DISCORD_${server}_BOT_TOKEN`;
  if (fs.existsSync(ENV_PATH)) {
    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.startsWith(`${key}=`)) {
        const val = line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
        if (val) return val;
      }
    }
  }
  return process.env[key] || '';
}

module.exports = {
  ROOT, DB_PATH, UPLOAD_DIR, ENV_PATH,
  PROXY_URL, PROXIES, DISCORD_UA, getProxyConfig,
  SCAN_INTERVAL, SEND_IMMEDIATE_WINDOW_MIN,
  CHANNELS, CHANNELS_FALLBACK,
  SERVER_SENDER, STATUS,
  loadChannels, getDiscordToken,
};

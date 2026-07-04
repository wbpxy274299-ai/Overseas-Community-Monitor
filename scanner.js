/**
 * DC 发布扫描器 (Node.js 版)
 * - Discord API 调用（发送/撤回）
 * - 常驻扫描进程（定时发送、取消、撤回）
 */
const fs = require('fs');
const path = require('path');
const {
  PROXY_URL, CHANNELS,
  SCAN_INTERVAL, SEND_IMMEDIATE_WINDOW_MIN,
  getDiscordToken, UPLOAD_DIR, STATUS,
} = require('./config');
const db = require('./db');
const log = require('./logger');
const discordClient = require('./discord_client');

const CST_OFFSET = 8 * 3600 * 1000;

function nowCst() {
  return new Date(); // 直接使用本地时间(CST),不需要手动加偏移
}

function formatCst(d) {
  // 格式化为本地时间字符串 (CST)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ===== Discord API（使用 Node.js 原生 discord_client）=====

async function discordSend(channelId, token, content, { imageUrls = [], localFiles = [] } = {}) {
  // 收集本地图片路径
  const imagePaths = [];
  for (const fpath of localFiles) {
    if (!fpath) continue;
    const fullPath = path.isAbsolute(fpath) ? fpath : path.join(UPLOAD_DIR, fpath);
    
    // 验证路径是否在允许目录内
    const normalizedPath = path.normalize(fullPath);
    if (!normalizedPath.startsWith(path.normalize(UPLOAD_DIR))) {
      throw new Error(`非法文件路径: ${fpath}`);
    }
    
    if (fs.existsSync(normalizedPath)) {
      imagePaths.push(normalizedPath);
    } else {
      console.warn(`  ⚠️ 本地图片不存在: ${normalizedPath}`);
    }
  }

  // 根据 channelId 查找对应的 server
  let server = 'TC'; // 默认
  for (const [name, info] of Object.entries(CHANNELS)) {
    if (info.channel_id === channelId) {
      server = info.bot;
      break;
    }
  }

  const result = await discordClient.sendMessage(channelId, server, content || '', imageUrls);
  if (!result.ok) throw new Error(result.error || '发送失败');
  return result.message_id;
}

async function discordRecall(channelId, token, messageId) {
  try {
    // 根据 channelId 查找对应的 server
    let server = 'TC'; // 默认
    for (const [name, info] of Object.entries(CHANNELS)) {
      if (info.channel_id === channelId) {
        server = info.bot;
        break;
      }
    }
    
    const result = await discordClient.deleteMessage(channelId, server, messageId);
    if (result.ok) {
      console.log(`  ✅ 撤回成功`);
      return true;
    } else {
      console.error(`  ❌ 撤回失败: ${result.error}`);
      return false;
    }
  } catch (e) {
    console.error(`  ❌ 撤回异常: ${e.message}`);
    return false;
  }
}

// ===== URL 提取 =====
function extractUrls(text) {
  if (!text) return [];
  const pattern = /https?:\/\/[^\s<>"']+?\.(?:png|jpg|jpeg|gif|webp|bmp|svg)(?:[^\s<>"']*)?/gi;
  const pattern2 = /https?:\/\/cdn\.discordapp\.com\/attachments\/\d+\/\d+\/[^\s<>"']+/gi;
  const urls = (text.match(pattern) || []).concat(text.match(pattern2) || []);
  return [...new Set(urls)];
}

// ===== 发送一条任务 =====
async function sendRecord(task) {
  const taskId = task.id;
  const channelName = task.channel_name;

  // 防重复发送
  const current = db.getTask(taskId);
  if (current && !['received', 'scheduled', 'sending'].includes(current.status)) {
    console.log(`  ⏭️ 任务#${taskId} 状态已变为 ${current.status}，跳过`);
    return;
  }

  if (!CHANNELS[channelName]) {
    db.updateTask(taskId, { status: 'failed', fail_reason: `频道 '${channelName}' 不在映射表中` });
    console.log(`  ❌ 频道 '${channelName}' 不存在`);
    return;
  }

  const { bot: server, channel_id: channelId } = CHANNELS[channelName];
  const token = getDiscordToken(server);
  if (!token) {
    db.updateTask(taskId, { status: 'failed', fail_reason: `${server} Bot Token 未配置` });
    console.log(`  ❌ ${server} Token 缺失`);
    return;
  }

  db.updateTask(taskId, { status: 'sending' });

  let content = task.content || '';
  const rawImages = task.image_urls || '';
  const localFiles = [];
  const netUrls = [];

  for (const item of rawImages.split(',').map(s => s.trim()).filter(Boolean)) {
    if (item.startsWith('http')) netUrls.push(item);
    else localFiles.push(item);
  }

  // 从 content 中提取图片 URL
  const contentUrls = extractUrls(content);
  const allNetUrls = [...new Set([...netUrls, ...contentUrls])];
  for (const u of contentUrls) {
    content = content.replace(u, '').trim();
  }

  if (!content && allNetUrls.length === 0 && localFiles.length === 0) {
    db.updateTask(taskId, { status: 'failed', fail_reason: '消息内容和图片都为空' });
    return;
  }

  try {
    const msgId = await discordSend(channelId, token, content, {
      imageUrls: allNetUrls,
      localFiles,
    });
    if (msgId) {
      db.updateTask(taskId, {
        status: 'sent',
        message_id: msgId,
        actual_time: formatCst(nowCst()),
      });
      log.info(`发送成功: #${taskId} → ${channelName} (msg#${msgId})`);
      console.log(`  ✅ 已发送至 ${channelName} (msg#${msgId})`);
    } else {
      db.updateTask(taskId, { status: 'failed', fail_reason: '发送成功但未获得 message_id' });
    }
  } catch (e) {
    db.updateTask(taskId, { status: 'failed', fail_reason: e.message });
    log.error(`发送失败: #${taskId} → ${channelName}: ${e.message}`);
    console.log(`  ❌ 发送异常: ${e.message}`);
  }
}

// ===== 扫描处理 =====

function parseSendTime(raw) {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  // 支持格式: 2025-01-01T12:00, 2025-01-01T12:00:00, 2025-01-01 12:00, 2025-01-01 12:00:00
  const patterns = [
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
    /^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})(?::(\d{2}))?$/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) {
      const [, Y, M, D, h, mi, sec] = m;
      // 直接构造本地时间，JavaScript会自动处理时区
      return new Date(+Y, +M - 1, +D, +h, +mi, +(sec || 0));
    }
  }
  return null;
}

async function processSend(task) {
  const taskId = task.id;
  const rawTime = task.send_time;

  if (!rawTime || !rawTime.trim()) {
    // 即时发送任务，直接发送
    console.log(`  ⚡ 任务#${taskId} 即时发送`);
    await sendRecord(task);
    return;
  }

  const sendTime = parseSendTime(rawTime);
  if (!sendTime) {
    db.updateTask(taskId, { status: 'failed', fail_reason: `时间格式错误: '${rawTime}'` });
    return;
  }

  const now = nowCst();
  const diff = (sendTime.getTime() - now.getTime()) / 60000;

  if (diff > SEND_IMMEDIATE_WINDOW_MIN) {
    if (task.status === 'received') {
      db.updateTask(taskId, { status: 'scheduled' });
    }
    const hh = String(sendTime.getHours()).padStart(2, '0'); // 直接使用本地时间的小时
    const mm = String(sendTime.getMinutes()).padStart(2, '0');
    console.log(`  📅 任务#${taskId} 定时 ${hh}:${mm}，还未到（差${diff.toFixed(1)}分钟）`);
    return;
  }

  // 进入5分钟窗口后，仍需检查是否已到目标时间
  if (diff > 0) {
    const hh = String(sendTime.getHours()).padStart(2, '0');
    const mm = String(sendTime.getMinutes()).padStart(2, '0');
    console.log(`  ⏳ 任务#${taskId} 定时 ${hh}:${mm}，已进入发送窗口（还差${diff.toFixed(1)}分钟），等待到点`);
    return;
  }

  // diff <= 0，已到达或超过目标时间，立即发送
  await sendRecord(task);
}

function processCancel(task) {
  const taskId = task.id;
  const msgId = task.message_id;

  if (!msgId) {
    db.updateTask(taskId, { status: 'cancelled', request_type: 'cancel' });
    console.log(`  🚫 任务#${taskId} 已取消`);
  } else {
    db.updateTask(taskId, { status: 'sent_no_cancel', fail_reason: '消息已发送，请改用撤回操作' });
    console.log(`  ⚠️ 任务#${taskId} 已发送无法取消`);
  }
}

async function processRecall(task) {
  const taskId = task.id;
  const channelName = task.channel_name;
  const msgId = task.message_id;

  if (!msgId) {
    db.updateTask(taskId, { status: 'failed', fail_reason: '无 message_id，无法撤回' });
    return;
  }
  if (!CHANNELS[channelName]) {
    db.updateTask(taskId, { status: 'failed', fail_reason: `频道 '${channelName}' 不在映射表中` });
    return;
  }

  const { bot: server, channel_id: channelId } = CHANNELS[channelName];
  const token = getDiscordToken(server);
  if (!token) {
    db.updateTask(taskId, { status: 'failed', fail_reason: `${server} Bot Token 未配置` });
    return;
  }

  const ok = await discordRecall(channelId, token, msgId);
  if (ok) {
    db.updateTask(taskId, { status: 'recalled' });
    console.log(`  🗑️ 任务#${taskId} 已撤回`);
  } else {
    db.updateTask(taskId, { status: 'failed', fail_reason: '撤回 API 调用失败' });
  }
}

// ===== 单次扫描 =====
async function runScan() {
  console.log(`\n${'='.repeat(40)}`);
  console.log(`🔍 开始扫描 ${formatCst(nowCst())}`);
  console.log(`${'='.repeat(40)}`);

  const tasks = db.getPendingTasks();
  if (tasks.length === 0) {
    console.log('  没有待处理任务');
    return;
  }

  for (const task of tasks) {
    const rtype = task.request_type || 'send';
    console.log(`\n  处理任务#${task.id} [${rtype}] → ${task.channel_name}`);
    if (rtype === 'send') await processSend(task);
    else if (rtype === 'cancel') processCancel(task);
    else if (rtype === 'recall') await processRecall(task);
    else {
      console.log(`  ⚠️ 未知 request_type: ${rtype}`);
      db.updateTask(task.id, { status: 'failed', fail_reason: `未知请求类型: ${rtype}` });
    }
  }

  console.log('\n✅ 本次扫描完成');
}

// ===== 常驻守护循环 =====
async function daemonLoop() {
  console.log(`🚀 DC 发布扫描器 v16.0 (Node.js) 启动`);
  console.log(`  扫描间隔: ${SCAN_INTERVAL}分钟`);
  console.log(`  职责: 定时发送 + 取消 + 撤回`);
  console.log(`  频道数量: ${Object.keys(CHANNELS).length}`);

  await db.initDb();

  while (true) {
    try {
      await runScan();
    } catch (e) {
      console.error(`❌ 扫描异常: ${e.message}`);
    }
    console.log(`  💤 等待 ${SCAN_INTERVAL} 分钟后再次扫描...`);
    await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL * 60 * 1000));
  }
}

// ===== 入口（如果是直接运行此文件） =====
if (require.main === module) {
  const mode = process.argv[2];
  (async () => {
    await db.initDb();
    if (mode === '--scan') {
      await runScan();
    } else if (mode === '--send' && process.argv[3]) {
      const task = db.getTask(parseInt(process.argv[3]));
      if (task) await sendRecord(task);
      else console.log(`❌ 任务#${process.argv[3]} 不存在`);
    } else {
      await daemonLoop();
    }
  })();
}

// ===== 从 Discord 读回真实消息 =====
async function fetchMessage(channelId, token, messageId) {
  // 根据 channelId 查找对应的 server
  let server = 'TC'; // 默认
  for (const [name, info] of Object.entries(CHANNELS)) {
    if (info.channel_id === channelId) {
      server = info.bot;
      break;
    }
  }
  
  const result = await discordClient.fetchMessage(channelId, server, messageId);
  if (result.error) throw new Error(result.error);
  return result;
}

// ===== 获取 Discord 频道信息 =====
async function fetchChannel(channelId, token) {
  // 根据 channelId 查找对应的 server
  let server = 'TC'; // 默认
  for (const [name, info] of Object.entries(CHANNELS)) {
    if (info.channel_id === channelId) {
      server = info.bot;
      break;
    }
  }
  
  const result = await discordClient.fetchChannel(channelId, server);
  if (result.error) throw new Error(result.error);
  return result;
}

async function fetchMessages(channelId, server, limit = 100) {
  const result = await discordClient.fetchMessages(channelId, server, limit);
  return result; // 返回消息数组（Discord API 原生格式）
}

module.exports = { 
  discordSend, 
  discordRecall, 
  sendRecord, 
  runScan, 
  daemonLoop, 
  fetchMessage, 
  fetchChannel, 
  fetchMessages,
  nowCst,
  formatCst
};

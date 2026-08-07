/**
 * Discord REST API 客户端（Node.js 原生版）
 * 替代 Python 桥接，直接用 axios 调 Discord REST API
 * 支持 TC/JP/SEA/KR 多 Bot Token
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getDiscordToken, UPLOAD_DIR } = require('./config');

const DISCORD_API_BASE = 'https://discord.com/api/v10';

// ★ 绕过 SSL 证书验证问题（Windows 环境自签名证书链问题）
// ⚠️ 仅限开发环境使用，生产环境应修复根证书
const sslBypassAgent = new https.Agent({
  rejectUnauthorized: false,  // 禁用 SSL 证书验证
});

/**
 * 获取频道消息列表
 * @param {string} channelId - Discord 频道 ID
 * @param {string} server - 服务器标识: 'TC' | 'JP' | 'SEA' | 'KR'
 * @param {number} limit - 获取消息数量（最大100，超出自动翻页）
 * @returns {Promise<Array>} Discord 消息对象数组
 */
async function fetchMessages(channelId, server = 'TC', limit = 100) {
  const token = getDiscordToken(server);
  if (!token) {
    console.error(`   ❌ ${server} Bot Token 未配置`);
    return [];
  }

  const axiosConfig = {
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  };

  const allMessages = [];
  let before = null; // 翻页游标

  try {
    while (allMessages.length < limit) {
      const batchSize = Math.min(limit - allMessages.length, 100); // Discord API 单次最多100
      let url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${batchSize}`;
      if (before) {
        url += `&before=${before}`;
      }

      const response = await axios.get(url, { ...axiosConfig, httpsAgent: sslBypassAgent });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        break; // 没有更多消息
      }

      allMessages.push(...response.data);

      // 如果返回不足 batchSize，说明已到底
      if (response.data.length < batchSize) {
        break;
      }

      // 翻页：用最后一条消息的 id 作为 before 游标
      before = response.data[response.data.length - 1].id;

      // 避免请求过快被限流
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`   ✅ Discord API 返回 ${allMessages.length} 条消息 (server=${server})`);
    return allMessages;
  } catch (e) {
    if (e.response?.status === 429) {
      const retryAfter = e.response.data?.retry_after || 5;
      console.log(`   ⏳ Discord API 限流，${retryAfter}秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return fetchMessages(channelId, server, limit); // 递归重试
    }
    // 网络错误：短暂等待后重试（最多1次）
    if ((e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') && !e._retried) {
      console.log(`   ⏳ Discord 网络错误，3秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      e._retried = true;
      return fetchMessages(channelId, server, limit);
    }
    console.error(`   ❌ Discord API 请求失败 (channel=${channelId}, server=${server}): ${e.message}`);
    if (e.response?.data) {
      console.error(`      响应: ${JSON.stringify(e.response.data)}`);
    }
    return [];
  }
}

// ===== 辅助：下载图片 URL 为 Buffer =====
async function downloadImageBuffer(url) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    httpsAgent: sslBypassAgent,
  });
  return Buffer.from(resp.data);
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    return ['.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg'].includes(ext) ? ext : '.png';
  } catch { return '.png'; }
}

// ===== 辅助：分割超长内容为 txt 文件 =====
function splitLongContent(content, channelName) {
  const MAX = 1950; // Discord 2000 字限制，留安全余量
  if (!content || content.length <= MAX) return { text: content, file: null };

  // 日本公告频道特殊：第一行保留为文字，其余行打包成 txt
  if (channelName === '日服-公告发布频道') {
    const nlIdx = content.indexOf('\n');
    if (nlIdx > 0 && nlIdx <= MAX) {
      return {
        text: content.substring(0, nlIdx),
        file: { name: 'message.txt', content: content.substring(nlIdx + 1) }
      };
    }
    // 单行超长，全部打包
    return { text: '', file: { name: 'message.txt', content } };
  }

  // 其他频道：全部打包成 txt
  return { text: '', file: { name: 'message.txt', content } };
}

/**
 * 发送消息到频道（支持文字 + 图片文件 + txt 附件）
 * @param {string} channelId - Discord 频道 ID
 * @param {string} server - 服务器标识
 * @param {string} content - 消息文本
 * @param {Object} options
 * @param {string[]} options.imageUrls - 网络图片 URL
 * @param {string[]} options.localFiles - 本地文件名（在 UPLOAD_DIR 中）
 * @param {string} options.channelName - 频道名称（用于特殊规则）
 * @returns {Promise<{ok: boolean, message_id?: string, error?: string}>}
 */
async function sendMessage(channelId, server = 'TC', content = '', options = {}) {
  const { imageUrls = [], localFiles = [], channelName = '' } = options;
  const token = getDiscordToken(server);
  if (!token) {
    return { ok: false, error: `${server} Bot Token 未配置` };
  }

  try {
    // 收集所有文件附件
    const files = [];
    let fileIdx = 0;

    // 1. 超长文本 → txt 附件
    const split = splitLongContent(content, channelName);
    if (split.file) {
      files.push({ name: `files[${fileIdx}]`, filename: split.file.name, data: Buffer.from(split.file.content, 'utf-8') });
      fileIdx++;
    }
    const sendContent = split.text || '';

    // 2. 本地上传图片
    for (const fname of localFiles) {
      if (!fname) continue;
      const fullPath = path.isAbsolute(fname) ? fname : path.join(UPLOAD_DIR, fname);
      if (fs.existsSync(fullPath)) {
        const data = fs.readFileSync(fullPath);
        const filename = path.basename(fullPath);
        files.push({ name: `files[${fileIdx}]`, filename, data });
        fileIdx++;
      } else {
        console.warn(`  ⚠️ 本地图片不存在: ${fullPath}`);
      }
    }

    // 3. 网络图片 URL → 下载后上传
    for (const url of imageUrls) {
      if (!url) continue;
      try {
        const data = await downloadImageBuffer(url);
        const filename = `image_${fileIdx}${extFromUrl(url)}`;
        files.push({ name: `files[${fileIdx}]`, filename, data });
        fileIdx++;
      } catch (e) {
        console.warn(`  ⚠️ 图片下载失败: ${url} - ${e.message}`);
      }
    }

    const axiosOpts = {
      timeout: 30000,
      headers: { 'Authorization': `Bot ${token}` },
    };

    let apiBody;
    if (files.length > 0) {
      // multipart/form-data（有附件时必须用这个格式）
      const FormData = require('form-data');
      const form = new FormData();
      const msgPayload = { content: sendContent || undefined };
      form.append('payload_json', JSON.stringify(msgPayload), { contentType: 'application/json' });
      for (const f of files) {
        form.append(f.name, f.data, { filename: f.filename });
      }
      apiBody = form;
      Object.assign(axiosOpts.headers, form.getHeaders());
    } else {
      // 纯文本 JSON
      apiBody = { content: sendContent };
      axiosOpts.headers['Content-Type'] = 'application/json';
    }

    const response = await axios.post(
      `${DISCORD_API_BASE}/channels/${channelId}/messages`,
      apiBody,
      { ...axiosOpts, httpsAgent: sslBypassAgent }
    );

    if (response.data?.id) {
      return { ok: true, message_id: response.data.id };
    }
    return { ok: false, error: '发送成功但未获得 message_id' };
  } catch (e) {
    const errData = e.response?.data;
    const errMsg = errData ? `${e.message}: ${JSON.stringify(errData).substring(0, 300)}` : e.message;
    return { ok: false, error: errMsg };
  }
}

/**
 * 删除消息（撤回）
 * @param {string} channelId - Discord 频道 ID
 * @param {string} server - 服务器标识
 * @param {string} messageId - 消息 ID
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function deleteMessage(channelId, server = 'TC', messageId) {
  const token = getDiscordToken(server);
  if (!token) {
    return { ok: false, error: `${server} Bot Token 未配置` };
  }

  try {
    await axios.delete(
      `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
      {
        headers: {
          'Authorization': `Bot ${token}`,
        },
        timeout: 30000,
        httpsAgent: sslBypassAgent,
      }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 获取单条消息
 */
async function fetchMessage(channelId, server = 'TC', messageId) {
  const token = getDiscordToken(server);
  if (!token) {
    return { error: `${server} Bot Token 未配置` };
  }

  try {
    const response = await axios.get(
      `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
      {
        headers: { 'Authorization': `Bot ${token}` },
        timeout: 15000,
        httpsAgent: sslBypassAgent,
      }
    );
    return response.data || { error: '未获取到消息' };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 获取频道信息
 */
async function fetchChannel(channelId, server = 'TC') {
  const token = getDiscordToken(server);
  if (!token) {
    return { error: `${server} Bot Token 未配置` };
  }

  try {
    const response = await axios.get(
      `${DISCORD_API_BASE}/channels/${channelId}`,
      {
        headers: { 'Authorization': `Bot ${token}` },
        timeout: 15000,
        httpsAgent: sslBypassAgent,
      }
    );
    return response.data || { error: '未获取到频道信息' };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 获取某个游标之后的新消息（增量采集用）
 * 打个比方：告诉 Discord "从上次追到那条消息开始，后面的新消息全给我"
 * @param {string} channelId - Discord 频道 ID
 * @param {string} server - 服务器标识: 'TC' | 'JP' | 'SEA' | 'KR'
 * @param {string} afterMessageId - 游标：从这条消息之后开始取
 * @param {number} maxLimit - 最多取多少条（默认 2000，足够覆盖几天）
 * @returns {Promise<Array>} Discord 消息对象数组
 */
async function fetchMessagesAfter(channelId, server = 'TC', afterMessageId, maxLimit = 2000) {
  const token = getDiscordToken(server);
  if (!token) {
    console.error(`   ❌ ${server} Bot Token 未配置`);
    return [];
  }

  const axiosConfig = {
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  };

  const allMessages = [];
  let after = afterMessageId;

  try {
    while (allMessages.length < maxLimit) {
      const batchSize = Math.min(maxLimit - allMessages.length, 100);
      const url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${batchSize}&after=${after}`;

      const response = await axios.get(url, { ...axiosConfig, httpsAgent: sslBypassAgent });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        break;
      }

      allMessages.push(...response.data);

      if (response.data.length < batchSize) {
        break;
      }

      // after 返回的是 ID 降序，最后一条是最旧的，用它继续往前翻
      after = response.data[response.data.length - 1].id;
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`   ✅ Discord 增量获取 ${allMessages.length} 条新消息 (server=${server})`);
    return allMessages;
  } catch (e) {
    if (e.response?.status === 429) {
      const retryAfter = e.response.data?.retry_after || 5;
      console.log(`   ⏳ Discord API 限流，${retryAfter}秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return fetchMessagesAfter(channelId, server, afterMessageId, maxLimit);
    }
    console.error(`   ❌ Discord 增量获取失败 (channel=${channelId}): ${e.message}`);
    return [];
  }
}

module.exports = {
  fetchMessages,
  fetchMessagesAfter,
  sendMessage,
  deleteMessage,
  fetchMessage,
  fetchChannel,
};

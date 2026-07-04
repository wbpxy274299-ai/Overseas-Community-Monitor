/**
 * Discord REST API 客户端（Node.js 原生版）
 * 替代 Python 桥接，直接用 axios 调 Discord REST API
 * 支持 TC/JP/SEA/KR 多 Bot Token
 */
const axios = require('axios');
const { getDiscordToken, getProxyConfig } = require('./config');

const DISCORD_API_BASE = 'https://discord.com/api/v10';

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

  const proxyConfig = getProxyConfig();
  const axiosConfig = {
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
    proxy: proxyConfig,
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

      const response = await axios.get(url, axiosConfig);

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
    console.error(`   ❌ Discord API 请求失败 (channel=${channelId}, server=${server}): ${e.message}`);
    if (e.response?.data) {
      console.error(`      响应: ${JSON.stringify(e.response.data)}`);
    }
    return [];
  }
}

/**
 * 发送消息到频道
 * @param {string} channelId - Discord 频道 ID
 * @param {string} server - 服务器标识
 * @param {string} content - 消息文本
 * @param {string[]} imageUrls - 图片 URL 列表（暂不支持，预留）
 * @returns {Promise<{ok: boolean, message_id?: string, error?: string}>}
 */
async function sendMessage(channelId, server = 'TC', content = '', imageUrls = []) {
  const token = getDiscordToken(server);
  if (!token) {
    return { ok: false, error: `${server} Bot Token 未配置` };
  }

  try {
    const proxyConfig = getProxyConfig();
    const response = await axios.post(
      `${DISCORD_API_BASE}/channels/${channelId}/messages`,
      { content },
      {
        headers: {
          'Authorization': `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        proxy: proxyConfig,
      }
    );

    if (response.data?.id) {
      return { ok: true, message_id: response.data.id };
    }
    return { ok: false, error: '发送成功但未获得 message_id' };
  } catch (e) {
    return { ok: false, error: e.message };
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
    const proxyConfig = getProxyConfig();
    await axios.delete(
      `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
      {
        headers: {
          'Authorization': `Bot ${token}`,
        },
        timeout: 30000,
        proxy: proxyConfig,
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
    const proxyConfig = getProxyConfig();
    const response = await axios.get(
      `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
      {
        headers: { 'Authorization': `Bot ${token}` },
        timeout: 15000,
        proxy: proxyConfig,
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
    const proxyConfig = getProxyConfig();
    const response = await axios.get(
      `${DISCORD_API_BASE}/channels/${channelId}`,
      {
        headers: { 'Authorization': `Bot ${token}` },
        timeout: 15000,
        proxy: proxyConfig,
      }
    );
    return response.data || { error: '未获取到频道信息' };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  fetchMessages,
  sendMessage,
  deleteMessage,
  fetchMessage,
  fetchChannel,
};

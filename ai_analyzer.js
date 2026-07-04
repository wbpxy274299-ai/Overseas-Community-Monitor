/**
 * AI 智能分析模块
 * 双 AI 后端：Google Gemini（主力） + Groq Cloud（备胎）
 * 功能：情感分析、话题提取、智能总结
 */

const axios = require('axios');
const { getProxyConfig } = require('./config');

// ===== AI API 配置 =====
// Gemini（主力）：免费、肚量大、中日文强
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-lite:generateContent';

// Groq（备胎）：速度快，用于兑底
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

/**
 * 调用 Google Gemini API
 * 优势：100万 token 上下文、中日文理解强、免费额度大
 */
async function callGeminiAPI(prompt, content, options = {}) {
  const { maxTokens = 500, jsonMode = false } = options;
  
  if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('粘贴')) {
    return null;
  }
  
  try {
    // 精简版模型不支持 systemInstruction，合并到用户内容里
    const fullText = jsonMode
      ? `[系统指令]\n${prompt}\n\n[用户内容]\n${content}\n\n请严格按 JSON 格式返回。`
      : `[系统指令]\n${prompt}\n\n[用户内容]\n${content}`;
    
    const requestBody = {
      contents: [{
        parts: [{ text: fullText }]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: maxTokens,
      }
    };
    
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      requestBody,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
        proxy: getProxyConfig()
      }
    );
    
    const candidates = response.data?.candidates;
    if (candidates && candidates[0]?.content?.parts?.[0]?.text) {
      return candidates[0].content.parts[0].text;
    }
    
    return null;
  } catch (e) {
    if (e.response?.status === 429) {
      console.log('    Gemini API 频率限制');
      return null;
    }
    console.error('❌ Gemini API 调用失败:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

/**
 * 调用 Groq API（备用通道）
 */
async function callGroqAPI(prompt, content, options = {}) {
  const { maxTokens = 500, jsonMode = false } = options;
  
  if (!GROQ_API_KEY) {
    return null;
  }
  
  try {
    // Groq 有请求体大小限制，截断用户内容避免 413
    const truncatedContent = content.length > 3000 ? content.substring(0, 3000) + '\n...(内容已截断)' : content;
    const requestBody = {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: truncatedContent }
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    };
    
    if (jsonMode) {
      requestBody.response_format = { type: 'json_object' };
    }
    
    const response = await axios.post(
      GROQ_API_URL,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000,
        proxy: getProxyConfig()
      }
    );
    
    if (response.data?.choices?.[0]) {
      return response.data.choices[0].message.content;
    }
    
    return null;
  } catch (e) {
    if (e.response?.status === 429) {
      console.log('    Groq API 频率限制');
      return null;
    }
    console.error('❌ Groq API 调用失败:', e.message);
    return null;
  }
}

/**
 * 统一 AI 调用入口
 * 优先用 Gemini（分析师），失败自动切 Groq 兑底
 * Groq 主要负责翻译工作（在 translator.js 中）
 */
async function callAI(prompt, content, options = {}) {
  // 优先使用 Gemini（分析师：负责话题分析、周报分析）
  const geminiResult = await callGeminiAPI(prompt, content, options);
  if (geminiResult) {
    console.log('   ✅ Gemini 返回成功');
    return geminiResult;
  }
  
  // Gemini 失败，降级 Groq
  console.log('   🔄 Gemini 不可用，切换 Groq 兑底');
  const groqResult = await callGroqAPI(prompt, content, options);
  if (groqResult) {
    console.log('   ✅ Groq 返回成功');
    return groqResult;
  }
  
  console.warn('   ⚠️ Gemini + Groq 均不可用');
  return null;
}

/**
 * AI 情感分析（比规则更准确）
 * 
 * @param {string} text - 玩家发言
 * @param {string} language - 语言类型: 'ja' | 'zh' | 'en'
 * @returns {Promise<Object>} { sentiment: 'positive'|'neutral'|'negative', confidence: number, reason: string }
 */
async function aiAnalyzeSentiment(text, language = 'ja') {
  const prompt = `你是一个游戏舆情分析专家。请分析以下玩家发言的情感倾向。

要求：
1. 判断情感：positive（正面）、neutral（中性）、negative（负面）
2. 给出置信度：0-1 之间的小数
3. 简要说明判断理由（20字以内）

请以 JSON 格式返回，例如：
{
  "sentiment": "positive",
  "confidence": 0.85,
  "reason": "表达了期待和兴奋"
}`;

  const result = await callAI(prompt, text);
  
  if (!result) {
    return { sentiment: 'neutral', confidence: 0.5, reason: 'AI 分析失败' };
  }
  
  try {
    // 尝试解析 JSON
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        sentiment: parsed.sentiment || 'neutral',
        confidence: parsed.confidence || 0.5,
        reason: parsed.reason || ''
      };
    }
  } catch (e) {
    console.warn('⚠️ AI 情感分析结果解析失败，使用默认值');
  }
  
  return { sentiment: 'neutral', confidence: 0.5, reason: '解析失败' };
}

/**
 * AI 提取关键话题
 * 
 * @param {string[]} texts - 多条玩家发言
 * @returns {Promise<string[]>} 提取的话题列表
 */
async function aiExtractTopics(texts) {
  if (!texts || texts.length === 0) {
    return [];
  }
  
  const combinedText = texts.slice(0, 20).join('\n---\n'); // 最多分析20条
  
  const prompt = `你是一个游戏舆情分析专家。请从以下玩家发言中提取关键话题。

要求：
1. 提取 3-5 个主要话题
2. 每个话题用简短的词语描述（不超过10个字）
3. 按重要性排序

请以 JSON 数组格式返回，例如：
["升级体验", "活动奖励", "公会招募"]`;

  const result = await callAI(prompt, combinedText);
  
  if (!result) {
    return [];
  }
  
  try {
    // 尝试解析 JSON 数组
    const arrayMatch = result.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0]);
      return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
    }
  } catch (e) {
    console.warn('⚠️ AI 话题提取结果解析失败');
  }
  
  // 降级：手动提取
  return [];
}

/**
 * AI 生成智能总结
 * 
 * @param {Object} stats - 统计数据
 * @param {Array} feedbacks - 玩家反馈列表
 * @returns {Promise<string>} 智能总结文本
 */
async function aiGenerateSummary(stats, feedbacks) {
  const sampleFeedbacks = feedbacks.slice(0, 10).map(f => ({
    platform: f.platform,
    content: f.translated_content || f.content,
    sentiment: f.sentiment
  }));
  
  const prompt = `你是一个游戏运营分析师。请根据以下舆情数据生成一份简洁的周报总结。

要求：
1. 总结整体情绪倾向
2. 指出主要关注点
3. 评估风险等级
4. 给出运营建议
5. 控制在 150 字以内

数据概览：
- Twitter 数据量：${stats.twitter_count} 条
- Discord 数据量：${stats.discord_count} 条
- 风险等级：${stats.risk_level}

部分样本反馈：
${JSON.stringify(sampleFeedbacks, null, 2)}`;

  const result = await callAI(prompt, '请生成总结');
  
  return result || '本周舆情整体平稳，建议持续关注玩家反馈。';
}

/**
 * AI 分类玩家反馈类型
 * 
 * @param {string} text - 玩家发言
 * @returns {Promise<string>} 分类结果: bug|suggestion|complaint|praise|question|other
 */
async function aiClassifyFeedback(text) {
  const prompt = `请将以下玩家反馈分类为以下类别之一：
- bug: BUG报告、技术问题
- suggestion: 功能建议、改进意见
- complaint: 投诉、不满
- praise: 表扬、好评
- question: 询问、求助
- other: 其他

只返回类别名称，不要其他内容。`;

  const result = await callAI(prompt, text);
  
  if (!result) {
    return 'other';
  }
  
  const category = result.trim().toLowerCase();
  const validCategories = ['bug', 'suggestion', 'complaint', 'praise', 'question', 'other'];
  
  return validCategories.includes(category) ? category : 'other';
}

/**
 * 批量分析（优化性能）
 * 
 * @param {Array} records - 舆情记录数组
 * @returns {Promise<Array>} 增强后的记录数组
 */
async function batchAnalyze(records) {
  const results = [];
  
  for (const record of records) {
    try {
      // AI 情感分析
      const sentimentResult = await aiAnalyzeSentiment(
        record.content,
        record.platform === 'twitter' ? 'ja' : 'zh'
      );
      
      // AI 分类
      const category = await aiClassifyFeedback(record.content);
      
      results.push({
        ...record,
        ai_sentiment: sentimentResult.sentiment,
        ai_confidence: sentimentResult.confidence,
        ai_reason: sentimentResult.reason,
        ai_category: category
      });
      
      // 避免频繁调用 API
      await new Promise(resolve => setTimeout(resolve, 300));
      
    } catch (e) {
      console.error(`❌ AI 分析失败 (ID: ${record.id}):`, e.message);
      results.push(record); // 保留原始记录
    }
  }
  
  return results;
}

// ===== AI 话题缓存（1小时 TTL）=====
let topicCache = { result: null, lastUpdated: 0, recordCount: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * 清除话题缓存（用于强制重新分析）
 */
function clearTopicCache() {
  topicCache = { result: null, lastUpdated: 0, recordCount: 0 };
  console.log('🧹 已清除话题缓存');
}

/**
 * 话题热度计算（代码算，不用AI）
 * 公式：基础分=count，负面+2，涉及bug/反馈+1，满分10
 */
function calculateHeat(count, sentiment, tag) {
  let heat = (count || 0);
  if (sentiment === 'negative') heat += 2;
  const lowerTag = (tag || '').toLowerCase();
  if (lowerTag.includes('bug') || lowerTag.includes('反馈')) heat += 1;
  return Math.min(Math.max(heat, 1), 10);
}

/**
 * 将记录按 topic_tag 分组，格式化为 AI 可读的文本
 * @param {boolean} truncate - 是否截断每条内容（Groq兑底时用）
 */
function groupRecordsByTag(records, prefix = '', truncate = false) {
  const groups = {};
  
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const tag = r.topic_tag || 'general';
    if (!groups[tag]) groups[tag] = [];
    let text = r.translated_content || r.content || '';
    if (truncate) text = text.substring(0, 100);
    const url = r.url ? ` (链接:${r.url})` : '';
    groups[tag].push(`[${prefix}${i+1}] ${text}${url}`);
  }
  
  // 格式化为文本
  const lines = [];
  const tagLabels = {
    bug_report: 'Bug/问题反馈', gacha: '抽卡/ガチャ', knight_order: '骑士团/公会',
    tree_bond: '树缘系统', event: '活动/狂潮', cosmetic: '时装/皮肤',
    world_boss: '世界Boss', photo: '拍照功能', pricing: '充值/价格',
    server: '服务器/合服', general: '其他讨论'
  };
  
  for (const [tag, msgs] of Object.entries(groups)) {
    const label = tagLabels[tag] || tag;
    lines.push(`\n【${label}】(${msgs.length}条)`);
    lines.push(...msgs);
  }
  
  return lines.join('\n');
}

/**
 * AI 热门话题总结（单平台，基于预分类数据）
 */
async function aiSummarizeHotTopics(records) {
  if (!records || records.length === 0) {
    return [];
  }
  
  console.log(`🤖 AI 分析 ${records.length} 条高质量记录...`);
  
  const content = groupRecordsByTag(records.slice(0, 15), '', false);
  const platform = records[0]?.source === 'twitter' ? 'Twitter（日服）' : 'Discord（繁中服）';
  
  const prompt = `你是《森之国度》(ツリネバ/TOS Neverland) 游戏的资深运营分析师。

以下是${platform}玩家真实发言，已按话题分类。

游戏背景：
- 树缘：核心社交结缘系统（玩家配对玩法）
- 骑士团/骑士团战：公会和公会战玩法
- 狂潮：限时挑战活动
- ガチャ：抽卡系统
- IP授权：灵犀互娱与韩国原厂的合作关系

❗❗❗ 核心要求（必须遵守）：

1. **summary 必须具体**：用 2-3 句话说清楚玩家在聊什么、为什么聊、诉求是什么
   ❌ 错误示范："玩家抱怨抽卡问题"
   ✅ 正确示范："多名玩家质疑 SSR 掉率过低，有人 100 抽零收获，认为保底机制不透明"

2. **detail 字段**：用 3-5 句话展开分析：
   - 具体发生了什么（事件描述）
   - 玩家的核心情绪和诉求
   - 影响范围（涉及多少玩家、哪个玩法）
   - 潜在风险（是否会发酵、是否涉及付费）

3. **representative_quotes 必须有**：直接引用 1-2 条玩家原话（中文），不要编造
   格式为对象数组：[{"text": "玩家原话", "created_at": "2026/6/17 14:30"}]
   created_at 从原始数据中获取，格式为 YYYY/MM/DD HH:mm

4. **urls 必须有**：从原始数据的 url 字段提取，每个话题至少放 1 条代表性发言的链接（字符串数组）

5. **每个有 ≥1 条讨论的标签都生成话题**，只有1条的归入“其他”

6. **情绪判断**：positive(赞美/期待) / neutral(讨论/询问) / negative(抱怨/批评)

7. **过滤搜索词**：“ツリネバ”是游戏名称/Yahoo搜索词，每条都有，不要作为热门话题。同理“TOSN”“TOSNeverland”也不算。

8. **❗❗ tag 必须从以下固定列表中选择（不允许自定义）**：
   - bug_report (Bug/问题反馈)
   - gacha (抽卡/ガチャ)
   - knight_order (骑士团/公会)
   - tree_bond (树缘系统)
   - event (活动/狂潮)
   - cosmetic (时装/皮肤)
   - world_boss (世界Boss)
   - photo (拍照功能)
   - pricing (充值/价格)
   - server (服务器/合服)
   - social (社交互动)
   - gameplay_balance (游戏平衡)
   - general (其他讨论)

返回 JSON 数组格式：
[{
  "title": "SSR掉率争议",  // 中文标题，具体到问题点
  "summary": "多名玩家反馈百抽无收获，质疑掉率低于宣传的1%",  // 2-3句具体描述
  "detail": "3名玩家分享抽卡经历，均为80-120抽零SSR。玩家认为官方未公开实际掉率，保底机制不透明，怀疑存在暗改。情绪偏愤怒，涉及付费相关内容，有公关风险。",  // 3-5句深度分析
  "sentiment": "negative",
  "tag": "gacha",
  "action": "公开实际掉率数据，优化保底说明",
  "count": 3,
  "representative_quotes": [{"text": "100抽了还是零，这掉率真的合理吗？", "created_at": "2026/6/17 14:30"}, {"text": "保底机制完全不透明", "created_at": "2026/6/17 15:45"}],
  "urls": ["https://twitter.com/xxx/status/123"]
}]

重要：请根据实际讨论内容生成，避免模板化表达！`;

  const result = await callAI(prompt, content, { maxTokens: 1500, jsonMode: true });
  
  if (!result) return fallbackTopicExtraction(records);
  
  try {
    let parsed;
    if (result.trim().startsWith('[')) {
      parsed = JSON.parse(result);
    } else {
      const m = result.match(/\[[\s\S]*\]/);
      if (m) parsed = JSON.parse(m[0]);
    }
    if (Array.isArray(parsed)) {
      return deduplicateTopics(parsed.map(t => ({
        title: t.title || '未命名',
        summary: t.summary || '',
        detail: t.detail || '',
        sentiment: t.sentiment || 'neutral',
        tag: standardizeTag(t.tag),
        action: t.action || '',
        count: t.count || 0,
        heat: calculateHeat(t.count, t.sentiment, t.tag),
        representative_quotes: t.representative_quotes || [],
        urls: t.urls || []
      })));
    }
  } catch (e) {
    console.warn('⚠️ AI 话题解析失败:', e.message);
  }
  
  return fallbackTopicExtraction(records);
}

// ===== 全局 tag 标准化（唯一入口，所有环节共用）=====
// ★ 这是防止热门话题重复的核心：AI 返回的 tag 必须在这里统一，
//   后续的去重、存储、显示全部使用标准化后的值，不会再出现不一致。
const ALLOWED_TAGS = [
  'bug_report', 'gacha', 'knight_order', 'tree_bond', 'event',
  'cosmetic', 'world_boss', 'photo', 'pricing', 'server',
  'social', 'gameplay_balance', 'general'
];
const TAG_MAP = {
  'Bug/问题反馈': 'bug_report', 'bug/问题反馈': 'bug_report', 'Bug反馈': 'bug_report', 'bug反馈': 'bug_report', 'bug': 'bug_report', 'Bug': 'bug_report', '问题反馈': 'bug_report',
  '抽卡/ガチャ': 'gacha', '抽卡': 'gacha', 'ガチャ': 'gacha',
  '骑士团/公会': 'knight_order', '骑士团': 'knight_order', '公会': 'knight_order',
  '树缘系统': 'tree_bond', '树缘': 'tree_bond',
  '活动/狂潮': 'event', '狂潮': 'event', '活动': 'event', 'activity': 'event',
  '时装/皮肤': 'cosmetic', '时装': 'cosmetic', '皮肤': 'cosmetic',
  '世界Boss': 'world_boss', '世界boss': 'world_boss',
  '拍照功能': 'photo', '拍照': 'photo',
  '充值/价格': 'pricing', '充值': 'pricing', '价格': 'pricing',
  '服务器/合服': 'server', '服务器': 'server', '合服': 'server',
  '社交互动': 'social', '社交': 'social',
  '游戏平衡': 'gameplay_balance', '平衡': 'gameplay_balance',
  '其他讨论': 'general', '其他': 'general', 'other': 'general'
};
function standardizeTag(tag) {
  if (!tag) return 'general';
  // ★ auto_ 前缀是 AI 哨兵发现的新话题，直接放行，不映射
  if (tag.startsWith('auto_')) return tag;
  if (ALLOWED_TAGS.includes(tag)) return tag;
  if (TAG_MAP[tag]) return TAG_MAP[tag];
  // 模糊匹配：尝试小写/去空格
  const lower = tag.trim().toLowerCase();
  for (const [alias, standard] of Object.entries(TAG_MAP)) {
    if (alias.toLowerCase() === lower) return standard;
  }
  return 'general';
}

/**
 * 话题去重：合并 AI 返回的重复话题
 * AI 有时会把同一个话题生成多份几乎相同的报告，这里合并处理
 * ★ 先标准化 tag，再按 title+tag 去重，确保不会因为 tag 不一致而漏掉合并
 */
function deduplicateTopics(topics) {
  if (!topics || topics.length <= 1) return topics;
  
  // 第一步：标准化所有 tag
  for (const topic of topics) {
    topic.tag = standardizeTag(topic.tag);
  }
  
  const merged = new Map();
  
  for (const topic of topics) {
    // 去重 key：标题（去掉空格、统一小写） + 标准化后的标签
    const key = `${(topic.title || '').replace(/\s+/g, '').toLowerCase()}_${topic.tag}`;
    
    if (merged.has(key)) {
      const existing = merged.get(key);
      // 合并：累加讨论数，重新计算热度
      existing.count = (existing.count || 0) + (topic.count || 0);
      existing.heat = calculateHeat(existing.count, existing.sentiment, existing.tag);
      // 保留更长的摘要
      if ((topic.summary || '').length > (existing.summary || '').length) {
        existing.summary = topic.summary;
      }
      // 合并玩家原声
      if (topic.representative_quotes && topic.representative_quotes.length > 0) {
        existing.representative_quotes = existing.representative_quotes || [];
        const existingQuotes = new Set(existing.representative_quotes);
        for (const q of topic.representative_quotes) {
          if (!existingQuotes.has(q)) existing.representative_quotes.push(q);
        }
      }
      // 合并链接
      if (topic.urls && topic.urls.length > 0) {
        existing.urls = existing.urls || [];
        const existingUrls = new Set(existing.urls);
        for (const u of topic.urls) {
          if (!existingUrls.has(u)) existing.urls.push(u);
        }
      }
      // 保留更长的运营建议
      if ((topic.action || '').length > (existing.action || '').length) {
        existing.action = topic.action;
      }
    } else {
      merged.set(key, { ...topic });
    }
  }
  
  const result = Array.from(merged.values());
  
  if (result.length < topics.length) {
    console.log(`   🧹 话题去重: ${topics.length} → ${result.length} 个（合并了 ${topics.length - result.length} 个重复）`);
  }
  
  return result;
}

/**
 * AI 热门话题总结（双平台一次性分析，带缓存）
 */
async function aiSummarizeHotTopicsDual(twitterRecords, discordRecords) {
  const hasTwitter = twitterRecords && twitterRecords.length > 0;
  const hasDiscord = discordRecords && discordRecords.length > 0;
  const totalRecords = (twitterRecords?.length || 0) + (discordRecords?.length || 0);
  
  if (!hasTwitter && !hasDiscord) {
    return { twitter_topics: [], discord_topics: [] };
  }
  
  // 检查缓存
  const now = Date.now();
  if (topicCache.result && 
      (now - topicCache.lastUpdated) < CACHE_TTL_MS &&
      Math.abs(totalRecords - topicCache.recordCount) < 10) {
    console.log('📦 使用 AI 话题缓存结果（1小时内，数据变化小于10条）');
    return topicCache.result;
  }
  
  // 只有一个平台有数据
  if (hasTwitter && !hasDiscord) {
    const topics = await aiSummarizeHotTopics(twitterRecords);
    const result = { twitter_topics: topics, discord_topics: [] };
    topicCache = { result, lastUpdated: now, recordCount: totalRecords };
    return result;
  }
  if (!hasTwitter && hasDiscord) {
    const topics = await aiSummarizeHotTopics(discordRecords);
    const result = { twitter_topics: [], discord_topics: topics };
    topicCache = { result, lastUpdated: now, recordCount: totalRecords };
    return result;
  }
  
  // 双平台：1 次 AI 调用（发完整内容给 Gemini）
  console.log(`🤖 AI 双平台分析：Twitter ${twitterRecords.length} 条 + Discord ${discordRecords.length} 条`);
  
  const twitterContent = groupRecordsByTag(twitterRecords.slice(0, 15), 'T', false);
  const discordContent = groupRecordsByTag(discordRecords.slice(0, 15), 'D', false);
  
  const content = `== Twitter（日服）玩家讨论 ==\n${twitterContent}\n\n== Discord（繁中服）玩家讨论 ==\n${discordContent}`;
  
  const prompt = `你是《森之国度》(ツリネバ/TOS Neverland) 游戏的资深运营分析师。

以下是玩家真实发言，已按话题分类。[T编号]=Twitter日服发言，[D编号]=Discord繁中服发言。

游戏背景：
- 树缘：核心社交结缘系统（玩家配对玩法）
- 骑士团/骑士团战：公会和公会战玩法
- 狂潮：限时挑战活动
- ガチャ：抽卡系统
- IP授权：灵犀互娱与韩国原厂的合作关系

❗❗❗ 核心要求（必须遵守）：

1. **summary 必须具体**：用 2-3 句话说清楚玩家在聊什么、为什么聊、诉求是什么
   ❌ 错误示范：“玩家抱怨抽卡问题”
   ✅ 正确示范：“多名玩家质疑 SSR 掉率过低，有人 100 抽零收获，认为保底机制不透明”

2. **detail 字段**：用 3-5 句话展开分析：
   - 具体发生了什么（事件描述）
   - 玩家的核心情绪和诉求
   - 影响范围（涉及多少玩家、哪个玩法）
   - 潜在风险（是否会发酵、是否涉及付费）

3. **representative_quotes 必须有**：直接引用 1-2 条玩家原话（中文），不要编造
   格式为对象数组：[{"text": "玩家原话", "created_at": "2026/6/17 14:30"}]
   created_at 从原始数据中获取，格式为 YYYY/MM/DD HH:mm

4. **urls 必须有**：从原始数据的 url 字段提取，每个话题至少放 1 条代表性发言的链接（字符串数组）

5. **每个有 ≥1 条讨论的标签都生成话题**，只有1条的归入“其他”

6. **情绪判断**：positive(赞美/期待) / neutral(讨论/询问) / negative(抱怨/批评)

7. **过滤搜索词**：“ツリネバ”是游戏名称/Yahoo搜索词，每条都有，不要作为热门话题。同理“TOSN”“TOSNeverland”也不算。

8. **❗❗ tag 必须从以下固定列表中选择（不允许自定义）**：
   - bug_report (Bug/问题反馈)
   - gacha (抽卡/ガチャ)
   - knight_order (骑士团/公会)
   - tree_bond (树缘系统)
   - event (活动/狂潮)
   - cosmetic (时装/皮肤)
   - world_boss (世界Boss)
   - photo (拍照功能)
   - pricing (充值/价格)
   - server (服务器/合服)
   - social (社交互动)
   - gameplay_balance (游戏平衡)
   - general (其他讨论)

返回 JSON 格式（热度由系统代码计算，你不需要返回 heat 字段）：
{
  "twitter_topics": [{
    "title": "SSR掉率争议",  // 中文标题，具体到问题点
    "summary": "多名玩家反馈百抽无收获，质疑掉率低于宣传的1%",  // 2-3句具体描述
    "detail": "3名玩家分享抽卡经历，均为80-120抽零SSR。玩家认为官方未公开实际掉率，保底机制不透明，怀疑存在暗改。情绪偏愤怒，涉及付费相关内容，有公关风险。",  // 3-5句深度分析
    "sentiment": "negative",
    "tag": "gacha",
    "action": "公开实际掉率数据，优化保底说明",
    "count": 3,
    "representative_quotes": [{"text": "100抽了还是零，这掉率真的合理吗？", "created_at": "2026/6/17 14:30"}, {"text": "保底机制完全不透明", "created_at": "2026/6/17 15:45"}],
    "urls": ["https://twitter.com/xxx/status/123"]
  }],
  "discord_topics": [同上格式]
}`;

  const result = await callAI(prompt, content, { maxTokens: 2500, jsonMode: true });
  
  if (!result) {
    console.log('⚠️ 双平台 AI 失败，降级分别分析');
    const [tw, dc] = await Promise.all([
      aiSummarizeHotTopics(twitterRecords),
      aiSummarizeHotTopics(discordRecords)
    ]);
    const finalResult = { twitter_topics: tw, discord_topics: dc };
    topicCache = { result: finalResult, lastUpdated: now, recordCount: totalRecords };
    return finalResult;
  }
  
  try {
    let parsed;
    if (result.trim().startsWith('{')) {
      parsed = JSON.parse(result);
    } else {
      const m = result.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }
    
    if (parsed) {
      const mapTopic = t => ({
        title: t.title || '未命名',
        summary: t.summary || '',
        detail: t.detail || '',
        sentiment: t.sentiment || 'neutral',
        tag: standardizeTag(t.tag),
        action: t.action || '',
        count: t.count || 0,
        heat: calculateHeat(t.count, t.sentiment, t.tag),
        representative_quotes: t.representative_quotes || [],
        urls: t.urls || []
      });
      
      // 代码校验：按 topic_tag 重新统计真实 count，覆盖 AI 的 count
      const realCounts = {};
      for (const r of [...twitterRecords, ...discordRecords]) {
        const tag = r.topic_tag || 'general';
        realCounts[tag] = (realCounts[tag] || 0) + 1;
      }
      
      const applyRealCounts = (topics) => topics.map(t => {
        const realCount = realCounts[t.tag] || t.count;
        return { ...t, count: realCount, heat: calculateHeat(realCount, t.sentiment, t.tag) };
      });
      
      const finalResult = {
        twitter_topics: applyRealCounts(deduplicateTopics((parsed.twitter_topics || []).map(mapTopic))),
        discord_topics: applyRealCounts(deduplicateTopics((parsed.discord_topics || []).map(mapTopic)))
      };
      topicCache = { result: finalResult, lastUpdated: now, recordCount: totalRecords };
      return finalResult;
    }
  } catch (e) {
    console.warn('⚠️ 双平台话题解析失败:', e.message);
  }
  
  // 降级结果不缓存（每次都重新判断，避免缓存低质量降级数据）
  const fallback = {
    twitter_topics: fallbackTopicExtraction(twitterRecords),
    discord_topics: fallbackTopicExtraction(discordRecords)
  };
  return fallback;
}

/**
 * 降级方案：基于关键词频率统计话题（简化版）
 */
function fallbackTopicExtraction(records) {
  const topicMap = {};
  // 搜索词黑名单：这些是 Yahoo 搜索关键词，每条都有，不算热门话题
  const blacklist = ['ツリネバ', 'tosn', 'tosneverland', 'tos neverland'];
  
  for (const record of records) {
    const keywords = record.keywords ? 
      (Array.isArray(record.keywords) ? record.keywords : record.keywords.split(',')) : [];
    
    for (const kw of keywords) {
      if (!kw || kw.trim().length < 2) continue;
      const normalizedKw = kw.trim().toLowerCase();
      if (blacklist.includes(normalizedKw)) continue; // 跳过搜索词
      if (!topicMap[normalizedKw]) topicMap[normalizedKw] = { count: 0 };
      topicMap[normalizedKw].count++;
    }
  }
  
  return Object.entries(topicMap)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([title, data]) => ({
      title,
      summary: `共有 ${data.count} 条相关讨论`,
      heat: calculateHeat(data.count, 'neutral', ''),
      sentiment: 'neutral',
      tag: 'general',
      action: '',
      count: data.count
    }));
}

/**
 * AI 哨兵：从 general 桶中发现新话题集群
 * 每天跑一次，自动归纳总结，自动保存，不需要人工确认
 * 
 * @param {Array} generalRecords - topic_tag 为 'general' 的发言记录
 * @returns {Promise<Array>} 新发现的话题（tag 带 auto_ 前缀）
 */
async function aiScoutNewTopics(generalRecords) {
  if (!generalRecords || generalRecords.length < 3) {
    return [];  // 少于 3 条不分析，不值得调 AI
  }
  
  console.log(`🔍 AI 哨兵: 分析 ${generalRecords.length} 条'其他讨论'，探测新话题...`);
  
  // 准备内容
  const lines = generalRecords.slice(0, 20).map((r, i) => {
    const text = (r.translated_content || r.content || '').substring(0, 120);
    const url = r.url ? ` (链接:${r.url})` : '';
    return `[${i + 1}] ${text}${url}`;
  });
  const content = lines.join('\n');
  
  const knownTags = 'bug_report, gacha, knight_order, tree_bond, event, cosmetic, world_boss, photo, pricing, server, social, gameplay_balance, general';
  
  const prompt = `你是《森之国度》游戏的舆情分析师。

以下是玩家发言中无法归入已知分类（${knownTags}）的部分。

请判断：这里面有没有聚集性的新话题？即多条发言在讨论同一个新内容（比如新系统、新活动、新联动等）。

要求：
1. 只有明显聚集的话题才返回（至少 3 条发言讨论同一件事）
2. 如果没有明显的新话题集群，返回空数组 []
3. 每个新话题用 2-3 句话总结，必须具体
4. representative_quotes 直接引用玩家原话，不要编造
5. urls 从原始数据提取
6. tag 用英文 snake_case，简洁描述新话题（如 pet_system, arena, collab）

返回 JSON 数组：
[{
  "title": "宠物系统期待",  // 中文标题
  "summary": "多名玩家讨论即将上线的宠物系统...",  // 2-3句具体描述
  "sentiment": "positive",
  "tag": "pet_system",
  "count": 5,
  "representative_quotes": [{"text": "玩家原话", "created_at": "2026/6/10 14:30"}],
  "urls": ["https://..."]
}]

如果没有发现新话题集群，返回 []`;
  
  const result = await callAI(prompt, content, { maxTokens: 1000, jsonMode: true });
  
  if (!result) {
    console.log('   🔍 AI 哨兵: 调用失败，跳过');
    return [];
  }
  
  try {
    let parsed;
    if (result.trim().startsWith('[')) {
      parsed = JSON.parse(result);
    } else {
      const m = result.match(/\[[\s\S]*\]/);
      if (m) parsed = JSON.parse(m[0]);
    }
    
    if (Array.isArray(parsed) && parsed.length > 0) {
      const topics = parsed.map(t => ({
        title: t.title || '未命名',
        summary: t.summary || '',
        detail: t.summary || '',  // 哨兵模式下 summary 作为 detail
        sentiment: t.sentiment || 'neutral',
        tag: `auto_${(t.tag || 'new').replace(/^auto_/, '')}`,  // 强制 auto_ 前缀
        action: '',
        count: t.count || 0,
        heat: calculateHeat(t.count || 0, t.sentiment || 'neutral', ''),
        representative_quotes: t.representative_quotes || [],
        urls: t.urls || []
      }));
      console.log(`   🆕 AI 哨兵: 发现 ${topics.length} 个新话题`);
      topics.forEach(t => console.log(`      - ${t.tag}: ${t.title} (${t.count}条)`));
      return topics;
    } else {
      console.log('   🔍 AI 哨兵: 未发现新话题集群');
    }
  } catch (e) {
    console.warn('   ⚠️ AI 哨兵解析失败:', e.message);
  }
  
  return [];
}

module.exports = {
  aiAnalyzeSentiment,
  aiExtractTopics,
  aiGenerateSummary,
  aiClassifyFeedback,
  aiSummarizeHotTopics,
  aiSummarizeHotTopicsDual,  // 双平台一次性分析
  batchAnalyze,
  clearTopicCache,           // 清除话题缓存
  standardizeTag,            // tag 标准化（全局唯一入口）
  aiScoutNewTopics,          // AI 哨兵：从 general 桶探测新话题
};

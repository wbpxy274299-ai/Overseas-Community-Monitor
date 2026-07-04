/**
 * 免费翻译服务模块
 * 使用 MyMemory Translation API（免费，无需 API Key）
 * 备选方案：LibreTranslate（开源自托管）
 */

const axios = require('axios');
const { getProxyConfig } = require('./config');

// 翻译缓存：避免重复翻译相同内容
const translationCache = new Map();

// 翻译前术语替换：确保游戏专有名词不被乱翻译
// 比喻：就像给快递包裹贴“勿动”标签，让翻译API不去碰这些词
const TERM_REPLACEMENTS = [
  { from: 'ツリネバ', to: 'TOSN' },
  { from: 'ﾄｽﾈﾊﾞ', to: 'TOSN' },  // 半角片假名版本
];

// Groq API 配置（用于翻译）
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * 翻译前预处理：替换游戏专有名词
 * 让翻译API不去碰这些词，保证术语统一
 */
function preProcessForTranslation(text) {
  let result = text;
  for (const r of TERM_REPLACEMENTS) {
    result = result.split(r.from).join(r.to);
  }
  return result;
}

/**
 * 使用 Groq AI 翻译文本（日语 -> 中文）
 * 作为 MyMemory API 的备选方案
 * 
 * @param {string} text - 要翻译的日语文本
 * @returns {Promise<string>} 翻译后的中文文本
 */
async function translateWithGroq(text) {
  if (!GROQ_API_KEY) {
    console.warn('   ⚠️ GROQ_API_KEY 未配置，无法使用 Groq 翻译');
    return text;
  }
  
  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: '你是一个专业的日语到中文翻译助手。请将日语文本翻译成简体中文，保持原意不变。注意：“TOSN”是游戏名称，保持原样不翻译。只返回翻译结果，不要添加任何解释。'
          },
          {
            role: 'user',
            content: text.substring(0, 500)
          }
        ],
        temperature: 0.3,
        max_tokens: 1000
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000,
        proxy: getProxyConfig()
      }
    );
    
    if (response.data && response.data.choices && response.data.choices.length > 0) {
      const translatedText = response.data.choices[0].message.content.trim();
      console.log(`   ✅ Groq 翻译成功`);
      return translatedText;
    }
    
    return text;
  } catch (e) {
    console.error('   ❌ Groq 翻译失败:', e.response?.data?.error?.message || e.message);
    return text;
  }
}

/**
 * 使用 MyMemory API 翻译文本（日语 -> 中文）
 * 免费额度：每天 1000 词
 * 
 * @param {string} text - 要翻译的日语文本
 * @param {number} retryCount - 重试次数（内部使用）
 * @returns {Promise<string>} 翻译后的中文文本
 */
async function translateJapaneseToChinese(text, retryCount = 0) {
  if (!text || text.trim().length === 0) {
    return '';
  }
  
  // 如果文本中没有日文字符，直接返回原文
  if (!hasJapaneseCharacters(text)) {
    return text;
  }
  
  // 翻译前预处理：替换游戏专有名词（如 ツリネバ → TOSN）
  const processedText = preProcessForTranslation(text);
  
  // 检查缓存
  const cacheKey = processedText.substring(0, 100); // 用处理后的文本作缓存键
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }
  
  try {
    const url = 'https://api.mymemory.translated.net/get';
    const params = {
      q: processedText.substring(0, 500), // API 限制每次最多 500 字符
      langpair: 'ja|zh-CN', // 日语 -> 简体中文
    };
    
    const response = await axios.get(url, { 
      params,
      timeout: 5000,
      proxy: getProxyConfig()
    });
    
    if (response.data && response.data.responseData) {
      const translatedText = response.data.responseData.translatedText;
      
      // 检查翻译质量
      if (translatedText && !translatedText.includes('MYMEMORY WARNING')) {
        // 存入缓存
        translationCache.set(cacheKey, translatedText);
        return translatedText;
      }
    }
    
    // 如果翻译失败，返回预处理后的文本（ツリネバ已替换为TOSN）
    console.warn('⚠️ 翻译失败，返回预处理文本:', processedText.substring(0, 50));
    return processedText;
    
  } catch (e) {
    // 429 错误表示频率限制，进行重试
    if (e.response && e.response.status === 429) {
      if (retryCount < 2) {
        // 指数退避：第1次等5秒，第2次等10秒
        const delay = (retryCount + 1) * 5000;
        console.log(`   ⏳ 翻译 API 频率限制，${delay/1000}秒后重试 (${retryCount + 1}/2)...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return translateJapaneseToChinese(text, retryCount + 1);
      } else {
        console.log('   🔄 MyMemory API 多次重试失败，切换到 Groq AI 翻译...');
        // 切换到 Groq 翻译
        return translateWithGroq(processedText);
      }
    }
    
    console.error(' 翻译 API 调用失败:', e.message);
    // 出错时尝试使用 Groq
    console.log('   🔄 尝试使用 Groq AI 翻译...');
    return translateWithGroq(processedText);
  }
}

/**
 * 检查文本是否包含日文字符
 * 
 * @param {string} text - 要检查的文本
 * @returns {boolean} 是否包含日文字符
 */
function hasJapaneseCharacters(text) {
  // 日语字符范围：
  // 平假名: \u3040-\u309F
  // 片假名: \u30A0-\u30FF
  // 汉字: \u4E00-\u9FFF
  // 全角符号: \uFF00-\uFFEF
  const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]/;
  return japaneseRegex.test(text);
}

module.exports = {
  translateJapaneseToChinese,
  hasJapaneseCharacters,
};

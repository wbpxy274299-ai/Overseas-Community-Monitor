/**
 * AI 翻译服务模块
 * 主力：DeepSeek AI（带游戏术语注入）
 * 
 * 比喻：翻译时给 AI 一本术语手册，让它知道"ルミ=露米，ツリネバ是游戏名别动"
 *      而不是瞎猜乱翻
 */

const axios = require('axios');
const crypto = require('crypto');
const { getProxyConfig } = require('./config');
const terminology = require('./terminology');

// 翻译缓存：避免重复翻译相同内容（省 API 调用费）
const translationCache = new Map();
const MAX_CACHE_SIZE = 5000;

// DeepSeek API 配置
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 游戏名称保护列表（翻译前替换成代码，翻译后还原）
// 比喻：给游戏名贴个"勿动"标签，防止 AI 瞎翻译
const GAME_NAMES = [
  { original: 'ツリネバ', code: '__GAME1__' },
  { original: 'ﾄｽﾈﾊﾞ', code: '__GAME1__' },  // 半角片假名
  { original: 'トスネバ', code: '__GAME1__' },
];

/**
 * 预处理：将游戏名替换为保护代码
 */
function protectGameNames(text) {
  let result = text;
  for (const g of GAME_NAMES) {
    result = result.split(g.original).join(g.code);
  }
  return result;
}

/**
 * 后处理：将保护代码还原为游戏名
 */
function restoreGameNames(text) {
  return text.split('__GAME1__').join('ツリネバ');
}

/**
 * 构建带术语的 system prompt
 * 比喻：给翻译官一本小手册，上面写着"这些词必须这么翻"
 */
function buildSystemPrompt(text) {
  let prompt = '你是一个专业的日语到中文翻译助手，专门翻译游戏相关内容。\n';
  prompt += '规则：\n';
  prompt += '1. 将日语翻译成简体中文，保持原意不变\n';
  prompt += '2. 口语化内容保持口语风格，不要翻译得太书面\n';
  prompt += '3. 只返回翻译结果，不要添加任何解释或注释\n';
  prompt += '4. 文本中的 __GAME1__ 是游戏名称占位符，必须在翻译中保留原样，不要删除或修改它\n';

  // 从术语库提取命中的术语
  const matchedTerms = terminology.findTermsInText(text, 20);
  if (matchedTerms.length > 0) {
    prompt += '\n\n以下是本文中包含的游戏术语，请严格按对照表翻译：\n';
    for (const term of matchedTerms) {
      prompt += `- ${term.ja} → ${term.zh}\n`;
    }
  }

  return prompt;
}

/**
 * 使用 DeepSeek AI 翻译文本（日语 -> 中文）
 * 带术语注入，保证翻译质量
 * 
 * @param {string} text - 要翻译的日语文本
 * @returns {Promise<string>} 翻译后的中文文本
 */
async function translateJapaneseToChinese(text) {
  if (!text || text.trim().length === 0) {
    return '';
  }

  // 如果文本中没有日文字符，直接返回原文
  if (!hasJapaneseCharacters(text)) {
    return text;
  }

  // 截断过长文本（API 有 token 限制）
  const rawText = text.substring(0, 800);

  // 保护游戏名称不被乱翻译
  const textToTranslate = protectGameNames(rawText);

  // 缓存 key：用完整文本的 MD5，避免不同推文因前150字相同而命中同一缓存
  const cacheKey = crypto.createHash('md5').update(textToTranslate).digest('hex');
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  // API Key 检查
  if (!DEEPSEEK_API_KEY) {
    console.warn('   ⚠️ DEEPSEEK_API_KEY 未配置，返回原文');
    return text;
  }

  try {
    const systemPrompt = buildSystemPrompt(textToTranslate);

    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: textToTranslate }
        ],
        temperature: 0.3,
        max_tokens: 1200
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000,
        proxy: getProxyConfig()
      }
    );

    if (response.data?.choices?.length > 0) {
      let translatedText = response.data.choices[0].message.content.trim();

      // 还原游戏名称
      translatedText = restoreGameNames(translatedText);

      // 清理推文格式噪音（START/END 是 Twitter 嵌入游戏标签的原始格式）
      translatedText = translatedText
        .replace(/START\s*ツリネバ\s*END/g, '')
        .replace(/START\s*TOSN\s*END/g, '')
        .replace(/#\s*START.*?END\s*/g, '')
        .replace(/START\s+END/g, '')
        .replace(/\t+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      // 存入缓存（限制缓存大小防止内存泄漏）
      if (translationCache.size >= MAX_CACHE_SIZE) {
        const firstKey = translationCache.keys().next().value;
        translationCache.delete(firstKey);
      }
      translationCache.set(cacheKey, translatedText);

      console.log(`   ✅ DeepSeek 翻译成功`);
      return translatedText;
    }

    return text;
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('   ❌ DeepSeek 翻译失败:', errMsg);
    return text;
  }
}

/**
 * 检查文本是否包含日文字符
 * 
 * @param {string} text - 要检查的文本
 * @returns {boolean} 是否包含日文字符
 */
function hasJapaneseCharacters(text) {
  // 只检测日语独有字符：平假名和片假名
  // CJK 汉字（\u4E00-\u9FFF）中日共用，不能用来判断
  // 打个比方：平假名/片假名就像日本人的"身份证"，有它才是日文
  const japaneseOnlyRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
  return japaneseOnlyRegex.test(text);
}

// ===== 韩文翻译扩展 =====

// 韩文游戏名保护列表
const KR_GAME_NAMES = [
  { original: '트리오브세이비어', code: '__KRGAME1__' },
  { original: '네버랜드', code: '__KRGAME2__' },
  { original: 'TOS', code: '__KRGAME3__' },
];

function protectKrGameNames(text) {
  let result = text;
  for (const g of KR_GAME_NAMES) {
    result = result.split(g.original).join(g.code);
  }
  return result;
}

function restoreKrGameNames(text) {
  let result = text;
  result = result.split('__KRGAME1__').join('트리오브세이비어');
  result = result.split('__KRGAME2__').join('네버랜드');
  result = result.split('__KRGAME3__').join('TOS');
  return result;
}

/**
 * 韩文→中文翻译（带游戏术语保护）
 * 和日文翻译用同一个 DeepSeek API，只是 prompt 不同
 */
async function translateKoreanToChinese(text) {
  if (!text || text.trim().length === 0) return '';

  const cacheKey = 'ko:' + crypto.createHash('md5').update(text).digest('hex');
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  if (!DEEPSEEK_API_KEY) {
    console.warn('⚠️ DeepSeek API Key 未配置，跳过韩文翻译');
    return '';
  }

  try {
    const protectedText = protectKrGameNames(text);
    const truncated = protectedText.length > 4000
      ? protectedText.substring(0, 4000) + '\n...(截断)'
      : protectedText;

    let systemPrompt = [
      '你是一个专业的韩语到中文翻译助手，专门翻译游戏社区内容。',
      '规则：',
      '1. 将韩语翻译成简体中文，保持原意不变',
      '2. 口语化/网络用语保持口语风格，不要翻译得太书面',
      '3. 游戏术语尽量用中文游戏圈常用的说法',
      '4. 只返回翻译结果，不要添加任何解释或注释',
      '5. __KRGAME1__、__KRGAME2__、__KRGAME3__ 是游戏名称占位符，必须原样保留',
      '6. 韩语网络缩写要还原意思再翻译（如 ㄹㅇ=真的, ㄷㄷ=震惊, ㅈㄱ=标题即内容）',
    ].join('\n');

    // 从术语库提取命中的韩文术语（和日文翻译一样的机制）
    const matchedTerms = terminology.findTermsInText(text, 20, 'kr');
    if (matchedTerms.length > 0) {
      systemPrompt += '\n\n以下是本文中包含的游戏术语，请严格按对照表翻译：\n';
      for (const term of matchedTerms) {
        systemPrompt += `- ${term.kr} → ${term.zh}\n`;
      }
    }

    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: truncated },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
        proxy: getProxyConfig(),
      }
    );

    let result = response.data?.choices?.[0]?.message?.content || '';
    result = restoreKrGameNames(result);

    if (translationCache.size >= MAX_CACHE_SIZE) {
      const firstKey = translationCache.keys().next().value;
      translationCache.delete(firstKey);
    }
    translationCache.set(cacheKey, result);

    return result;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('⚠️ DeepSeek 频率限制，韩文翻译跳过');
    } else {
      console.error('❌ 韩文翻译失败:', err.message);
    }
    return '';
  }
}

module.exports = {
  translateJapaneseToChinese,
  translateKoreanToChinese,
  hasJapaneseCharacters,
};

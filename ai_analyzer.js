/**
 * AI 智能分析模块
 * 单 AI 后端：DeepSeek（OpenAI 兼容格式）
 * 功能：情感分析、话题提取、智能总结
 */

const axios = require('axios');

// ===== DeepSeek AI 配置 =====
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

/**
 * 调用 DeepSeek API
 * OpenAI 兼容格式，中日文理解能力强
 * 带重试机制：限流(429)和网络错误自动重试
 */
async function callDeepSeekAPI(prompt, content, options = {}) {
  const { maxTokens = 500, jsonMode = false } = options;
  
  if (!DEEPSEEK_API_KEY) {
    return null;
  }
  
  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 截断超长内容，避免请求体过大
      const truncatedContent = content.length > 6000 ? content.substring(0, 6000) + '\n...(内容已截断)' : content;
      
      const requestBody = {
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: truncatedContent }
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
      };
      
      if (jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }
      
      const response = await axios.post(
        DEEPSEEK_API_URL,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000,
        }
      );
      
      if (response.data?.choices?.[0]) {
        return response.data.choices[0].message.content;
      }
      
      return null;
    } catch (e) {
      // 429 限流：等待后重试
      if (e.response?.status === 429 && attempt < maxRetries) {
        const retryAfter = e.response.data?.retry_after || 5;
        console.log(`    ⏳ DeepSeek 限流，${retryAfter}秒后重试 (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      // 网络错误：短暂等待后重试
      if ((e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') && attempt < maxRetries) {
        console.log(`    ⏳ DeepSeek 网络错误，3秒后重试 (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      // 其他错误或已达最大重试次数
      console.error(`❌ DeepSeek API 调用失败 (尝试${attempt}次): ${e.response?.data?.error?.message || e.message}`);
      return null;
    }
  }
  return null;
}

/**
 * 统一 AI 调用入口
 * 使用 DeepSeek 作为唯一 AI 后端
 */
async function callAI(prompt, content, options = {}) {
  const result = await callDeepSeekAPI(prompt, content, options);
  if (result) {
    console.log('   ✅ DeepSeek 返回成功');
    return result;
  }
  
  console.warn('   ⚠️ DeepSeek 不可用');
  return null;
}

// ===== JSON 安全解析（带自动修复）=====
// 打个比方：AI 有时候写 JSON 像写作文写错别字，这个函数就是「自动纠错老师」
function safeJsonParse(text, context = '') {
  if (!text) return null;
  
  // 第1次：直接解析
  try {
    return JSON.parse(text);
  } catch (_) {}
  
  // 第2次：清理常见 AI 格式错误后再解析
  try {
    let cleaned = text
      // 去掉代码块标记
      .replace(/```json\s*/gi, '').replace(/```\s*/g, '')
      // 去掉尾部多余的逗号（如 ,} 或 ,]）
      .replace(/,\s*([\]}])/g, '$1')
      // 把单引号换成双引号（AI 偶尔用单引号）
      .replace(/(?<=[\[{,])\s*'([^']*)'\s*(?=[,\]}:])/g, ' "$1" ')
      // 去掉 BOM 和不可见字符
      .replace(/[\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch (_) {}
  
  // 第3次：尝试提取 JSON 片段再修复
  try {
    // 尝试提取 {...} 或 [...]
    const jsonObj = text.match(/\{[\s\S]*\}/);
    const jsonArr = text.match(/\[[\s\S]*\]/);
    const candidate = jsonObj ? jsonObj[0] : (jsonArr ? jsonArr[0] : null);
    if (candidate) {
      let cleaned = candidate
        .replace(/,\s*([\]}])/g, '$1')
        .replace(/[\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .trim();
      return JSON.parse(cleaned);
    }
  } catch (_) {}
  
  console.warn(`⚠️ JSON 解析彻底失败 [${context}]，前100字: ${text.substring(0, 100)}`);
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
      const parsed = safeJsonParse(jsonMatch[0], '情感分析');
      if (!parsed) throw new Error('解析为空');
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
      const parsed = safeJsonParse(arrayMatch[0], '话题提取');
      if (!parsed) throw new Error('解析为空');
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
 * @param {boolean} truncate - 是否截断每条内容
 */
function groupRecordsByTag(records, prefix = '', truncate = false) {
  const groups = {};
  
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const tag = r.topic_tag || 'general';
    if (!groups[tag]) groups[tag] = [];
    let text = r.translated_content || r.content || '';
    if (truncate) text = text.substring(0, 100);
    const url = r.url ? ` (リンク:${r.url})` : '';
    // 把发帖时间也带上，AI 才能知道真实日期
    const timeStr = r.created_at ? ` (時間:${r.created_at})` : '';
    groups[tag].push(`[${prefix}${i+1}] ${text}${timeStr}${url}`);
  }
  
  // 格式化为テキスト
  const lines = [];
  const tagLabels = {
    bug_report: 'Bug/問題フィードバック', gacha: 'ガチャ', knight_order: '騎士団/ギルド',
    tree_bond: 'ツリーボンドシステム', event: 'イベント/マッドセイドン', cosmetic: '衣装/スキン',
    world_boss: 'ワールドボス', photo: '撮影機能', pricing: '課金/価格',
    server: 'サーバー/合併', general: 'その他のディスカッション'
  };
  
  for (const [tag, msgs] of Object.entries(groups)) {
    const label = tagLabels[tag] || tag;
    lines.push(`\n【${label}】(${msgs.length}件)`);
    lines.push(...msgs);
  }
  
  return lines.join('\n');
}

/**
 * 运营内容安全过滤：判断话题是否涉及运营团队
 * 用于兜底删除 AI 可能遗漏的运营相关话题
 */
function isOperationsTopic(topic) {
  if (!topic) return false;
  const text = `${topic.title || ''} ${topic.summary || ''} ${topic.detail || ''} ${topic.action || ''}`.toLowerCase();
  // 运营相关关键词（中/日/繁中）
  const opsKeywords = [
    '运营', '營運', '運営', '客服', 'gm', '官方態度', '官方信用', '官方返答',
    '官方コミュニケーション', '運営チーム', '運営信用', '運営不作為', '運営不信頼',
    '客服態度', '客服返答', '官方返答', '運営チーム', '運営戦略'
  ];
  return opsKeywords.some(kw => text.includes(kw));
}

/**
 * AI 热门话题总结（单平台，基于预分类数据）
 */
async function aiSummarizeHotTopics(records) {
  if (!records || records.length === 0) {
    return [];
  }
  
  console.log(`🤖 AI 分析 ${records.length} 条记录（7日全量）...`);
  
  // ★ 全量数据喂给 AI（不再只取15条），每条截断100字控制 token；超300条保险丝截断
  const inputRecords = records.length > 300 ? records.slice(0, 300) : records;
  if (records.length > 300) console.log(`⚠️ ${records.length} 条超过300条上限，截取热度最高的前300条`);
  const content = groupRecordsByTag(inputRecords, '', true);
  const src = records[0]?.source || '';
  const platform = src === 'twitter' ? 'Twitter（日服）' : src === 'lounge' ? 'Naver Lounge（韓国服）' : 'Discord（繁中服）';
  const gameContext = src === 'lounge'
    ? '게임 배경:\n- 트리본드: 핵심 소셜 페어링 시스템\n- 기사단/기사단전: 길드 및 길드전\n- 매드세이돈: 한정 챌린지 이벤트\n- 가챠: 가챠 시스템\n- 월드보스: 월드보스 레이드'
    : `ゲーム背景：\n- ツリーボンド：コアソーシャルペアリングシステム（プレイヤーペアリングプレイ）\n- 騎士団/騎士団戦：ギルドとギルド戦プレイ\n- マッドセイドン：リミテッドチャレンジイベント\n- ガチャ：ガチャシステム\n- IPライセンス：リュシイムタエンと韓国原産とのコラボレーション関係`;
  
  const prompt = `你是《森の国度》(ツリネバ/TOS Neverland) 游戏の资深運営アナリスト。

以下是${platform}プレイヤーのリアルな発言、既にトピック別に分類されています。

${gameContext}

❗❗❗ コア要件（遵守しなければならない）：

1. **summary 必須具体的**：2-3文でプレイヤーが何について話しているか、なぜ話しているか、何を求めているかを説明する
   ❌ 間違いの例："プレイヤーがガチャ問題を抱怨している"
   ✅ 正しい例："複数のプレイヤーがSSRドロップ率が低すぎると言っている、100ガチャでゼロSSRの人がいる、保証メカニズムが透明でないと思われている"

2. **detail フィールド**：3-5文で分析を展開する：
   - 具体なことが起きた（イベントの説明）
   - プレイヤーのコアな感情と要求
   - 影響範囲（どのプレイヤー、どのプレイ）
   - 潜在的なリスク（発酵する可能性、課金に関連しているかどうか）

3. **representative_quotes 必須ある**：1-2文のプレイヤーの原語を直接引用（偽造しない）
   オブジェクト配列の形式：[{"text": "プレイヤーの原語", "created_at": "2026/6/17 14:30"}]
   created_at は元データから取得し、YYYY/MM/DD HH:mm の形式

4. **urls 必須ある**：元データの url フィールドから抽出し、各トピックには少なくとも1つの代表的な発言のリンク（文字列配列）

5. **1件以上の議論があるタグごとにトピックを生成**、1件しかない場合は「その他」に分類する

6. **感情判断**：positive(称賛/期待) / neutral(ディスカッション/質問) / negative(抱怨/批評)

7. **検索ワードをフィルタリング**："ツリネバ"はゲーム名/Yahoo検索ワードであり、すべての行に含まれていますので、ホットトピックにはならない。同様に"TOSN""TOSNeverland"も該当しない。

8. **❗❗ 運営関連の内容はスキップ（トピックを生成しない）**：
   プレイヤーが「運営/營運/運営/カスタマーサポート/公式態度/公式信用/公式返答/GM管理」などの運営チームに関する内容をコアとして議論している場合、**スキップし、トピックを生成しない**。
   判断基準：トピックのコアな要求が運営チームの行動、態度、信用、コミュニケーション方法に対する批評や不満である。
   注意：ゲームメカニズムの問題（バグ、バランス調整など）であっても、プレイヤーが「公式」と言及していても、運営トピックにはならないので、通常通り生成する。

9. **❗❗ tag は以下の固定リストから選択する（カスタムは許可しない）**：
   - bug_report (Bug/問題フィードバック)
   - gacha (ガチャ)
   - knight_order (騎士団/ギルド)
   - tree_bond (ツリーボンドシステム)
   - event (イベント/マッドセイドン)
   - cosmetic (衣装/スキン)
   - world_boss (ワールドボス)
   - photo (撮影機能)
   - pricing (課金/価格)
   - server (サーバー/合併)
   - social (ソーシャルインタラクション)
   - gameplay_balance (ゲームバランス)
   - general (その他のディスカッション)

返却 JSON 配列：
[{
  "title": "SSRドロップ率の議論",  // 中文タイトル、具体的な問題点
  "summary": "複数のプレイヤーが100ガチャでゼロSSRを報告し、ドロップ率が宣伝の1%より低いと疑問を投げている",  // 2-3文具体的な説明
  "detail": "3人のプレイヤーが80-120ガチャでゼロSSRを経験した。プレイヤーは公式が実際のドロップ率を公開していないと主張し、保証メカニズムが透明でないと疑い、暗改を疑っている。感情は怒り、課金に関連しているため、PRリスクがある。",  // 3-5文の詳細な分析
  "sentiment": "negative",
  "tag": "gacha",
  "action": "実際のドロップ率データを公開し、保証の説明を最適化する",
  "count": 3,
  "representative_quotes": [{"text": "100ガチャしてもゼロ、このドロップ率は本当に適切ですか？", "created_at": "2026/6/17 14:30"}, {"text": "保証メカニズムは完全に透明ではありません", "created_at": "2026/6/17 15:45"}],
  "urls": ["https://twitter.com/xxx/status/123"]
}]

重要：実際のディスカッション内容に基づいて生成し、テンプレート化した表現を避ける！`;

  const result = await callAI(prompt, content, { maxTokens: 2000, jsonMode: true });
  
  if (!result) return fallbackTopicExtraction(records);
  
  try {
    let parsed = safeJsonParse(result, 'ホットトピック');
    if (!parsed) {
      const m = result.match(/\[[\s\S]*\]/);
      if (m) parsed = safeJsonParse(m[0], 'ホットトピック-抽出');
    }
    if (Array.isArray(parsed)) {
      // 運営内容安全フィルタリング：AIが見落としている可能性のある運営関連トピックを兜底的に削除する
      const filtered = parsed.filter(t => !isOperationsTopic(t));
      if (filtered.length < parsed.length) {
        console.log(`🔒 運営内容フィルタリング: ${parsed.length - filtered.length} 件の運営関連トピックを削除`);
      }
      return deduplicateTopics(filtered.map(t => ({
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
    console.warn('⚠️ AI トピック解析に失敗:', e.message);
  }
  
  return fallbackTopicExtraction(records);
}

// ===== 全局 tag 标准化（唯一入口，所有环节共用）=====
// ★ これはホットトピックの重複を防ぐコア：AIが返すtagはここで一括して標準化し、
//   後続の重複除去、保存、表示はすべて標準化後の値を使用し、不一致は起こらない。
const ALLOWED_TAGS = [
  'bug_report', 'gacha', 'knight_order', 'tree_bond', 'event',
  'cosmetic', 'world_boss', 'photo', 'pricing', 'server',
  'social', 'gameplay_balance', 'general'
];
const TAG_MAP = {
  'Bug/問題フィードバック': 'bug_report', 'bug/問題フィードバック': 'bug_report', 'Bugフィードバック': 'bug_report', 'bugフィードバック': 'bug_report', 'bug': 'bug_report', 'Bug': 'bug_report', '問題フィードバック': 'bug_report',
  'ガチャ': 'gacha', 'ガチャ': 'gacha',
  '騎士団/ギルド': 'knight_order', '騎士団': 'knight_order', 'ギルド': 'knight_order',
  'ツリーボンドシステム': 'tree_bond', 'ツリーボンド': 'tree_bond',
  'イベント/マッドセイドン': 'event', 'マッドセイドン': 'event', 'イベント': 'event', 'activity': 'event',
  '衣装/スキン': 'cosmetic', '衣装': 'cosmetic', 'スキン': 'cosmetic',
  'ワールドボス': 'world_boss', 'ワールドボス': 'world_boss',
  '撮影機能': 'photo', '撮影': 'photo',
  '課金/価格': 'pricing', '課金': 'pricing', '価格': 'pricing',
  'サーバー/合併': 'server', 'サーバー': 'server', '合併': 'server',
  'ソーシャルインタラクション': 'social', 'ソーシャル': 'social',
  'ゲームバランス': 'gameplay_balance', 'バランス': 'gameplay_balance',
  'その他のディスカッション': 'general', 'その他の': 'general', 'other': 'general'
};
function standardizeTag(tag) {
  if (!tag) return 'general';
  // ★ auto_ プレフィックスはAI哨兵が見つけた新しいトピックであり、そのまま通す
  if (tag.startsWith('auto_')) return tag;
  if (ALLOWED_TAGS.includes(tag)) return tag;
  if (TAG_MAP[tag]) return TAG_MAP[tag];
  // 模糊マッチ：小文字化/スペース除去
  const lower = tag.trim().toLowerCase();
  for (const [alias, standard] of Object.entries(TAG_MAP)) {
    if (alias.toLowerCase() === lower) return standard;
  }
  return 'general';
}

/**
 * トピックの重複除去：AIが返す重複したトピックをマージする
 * AIは同じトピックについて複数のほぼ同じレポートを生成することがあり、ここではマージ処理を行う
 * ★ まずtagを標準化し、title+tagで重複除去し、tagの不一致によるマージ漏れを防ぐ
 */
function deduplicateTopics(topics) {
  if (!topics || topics.length <= 1) return topics;
  
  // 第1ステップ：すべてのtagを標準化
  for (const topic of topics) {
    topic.tag = standardizeTag(topic.tag);
  }
  
  const merged = new Map();
  
  for (const topic of topics) {
    // 重複キー：タイトル（スペース除去、小文字化）+ 標準化されたタグ
    const key = `${(topic.title || '').replace(/\s+/g, '').toLowerCase()}_${topic.tag}`;
    
    if (merged.has(key)) {
      const existing = merged.get(key);
      // マージ：議論数を累積し、熱度を再計算
      existing.count = (existing.count || 0) + (topic.count || 0);
      existing.heat = calculateHeat(existing.count, existing.sentiment, existing.tag);
      // より長い要約を保持
      if ((topic.summary || '').length > (existing.summary || '').length) {
        existing.summary = topic.summary;
      }
      // プレイヤーの原声をマージ
      if (topic.representative_quotes && topic.representative_quotes.length > 0) {
        existing.representative_quotes = existing.representative_quotes || [];
        const existingQuotes = new Set(existing.representative_quotes);
        for (const q of topic.representative_quotes) {
          if (!existingQuotes.has(q)) existing.representative_quotes.push(q);
        }
      }
      // リンクをマージ
      if (topic.urls && topic.urls.length > 0) {
        existing.urls = existing.urls || [];
        const existingUrls = new Set(existing.urls);
        for (const u of topic.urls) {
          if (!existingUrls.has(u)) existing.urls.push(u);
        }
      }
      // より長い運用アドバイスを保持
      if ((topic.action || '').length > (existing.action || '').length) {
        existing.action = topic.action;
      }
    } else {
      merged.set(key, { ...topic });
    }
  }
  
  const result = Array.from(merged.values());
  
  if (result.length < topics.length) {
    console.log(`   🧹 トピックの重複除去: ${topics.length} → ${result.length} 件（${topics.length - result.length} 件をマージ）`);
  }
  
  return result;
}

/**
 * AI 热門话题总结（多平台一次性分析，带缓存）
 * 支持 Twitter + Discord + 韓国 Lounge 三平台
 */
async function aiSummarizeHotTopicsDual(twitterRecords, discordRecords, loungeRecords) {
  const hasTwitter = twitterRecords && twitterRecords.length > 0;
  const hasDiscord = discordRecords && discordRecords.length > 0;
  const hasLounge = loungeRecords && loungeRecords.length > 0;
  const totalRecords = (twitterRecords?.length || 0) + (discordRecords?.length || 0) + (loungeRecords?.length || 0);
  
  if (!hasTwitter && !hasDiscord && !hasLounge) {
    return { twitter_topics: [], discord_topics: [], lounge_topics: [] };
  }
  
  // 检查缓存（只使用有话题的缓存，0话题缓存视为失败）
  const now = Date.now();
  if (topicCache.result && 
      (now - topicCache.lastUpdated) < CACHE_TTL_MS &&
      Math.abs(totalRecords - topicCache.recordCount) < 10) {
    const cachedTotal = (topicCache.result.twitter_topics?.length || 0) + (topicCache.result.discord_topics?.length || 0) + (topicCache.result.lounge_topics?.length || 0);
    if (cachedTotal > 0) {
      console.log('📦 使用 AI 话题缓存结果（1小时内，データ変化小于10条）');
      return topicCache.result;
    }
    console.log('⚠️ キャッシュ結果が0トピックなので、キャッシュをスキップし、再分析');
  }
  
  const cacheIfHasTopics = (result) => {
    const total = (result.twitter_topics?.length || 0) + (result.discord_topics?.length || 0) + (result.lounge_topics?.length || 0);
    if (total > 0) {
      topicCache = { result, lastUpdated: now, recordCount: totalRecords };
    }
    return result;
  };

  // 只有一个プラットフォームにデータがある
  const activePlatforms = [hasTwitter, hasDiscord, hasLounge].filter(Boolean).length;
  if (activePlatforms === 1) {
    if (hasTwitter) {
      const topics = await aiSummarizeHotTopics(twitterRecords);
      const result = { twitter_topics: topics, discord_topics: [], lounge_topics: [] };
      cacheIfHasTopics(result);
      return result;
    }
    if (hasDiscord) {
      const topics = await aiSummarizeHotTopics(discordRecords);
      const result = { twitter_topics: [], discord_topics: topics, lounge_topics: [] };
      cacheIfHasTopics(result);
      return result;
    }
    if (hasLounge) {
      const topics = await aiSummarizeHotTopics(loungeRecords);
      const result = { twitter_topics: [], discord_topics: [], lounge_topics: topics };
      cacheIfHasTopics(result);
      return result;
    }
  }
  
  // 複数プラットフォーム：1回のAI呼び出し
  const platformDesc = [
    hasTwitter ? `Twitter ${twitterRecords.length} 件` : '',
    hasDiscord ? `Discord ${discordRecords.length} 件` : '',
    hasLounge ? `韓国 ${loungeRecords.length} 件` : ''
  ].filter(Boolean).join(' + ');
  console.log(`🤖 AI 多プラットフォーム分析：${platformDesc}`);
  
  // コンテンツの構築
  const contentParts = [];
  if (hasTwitter) contentParts.push(`== Twitter（日服）プレイヤーのディスカッション ==\n${groupRecordsByTag(twitterRecords.slice(0, 15), 'T', false)}`);
  if (hasDiscord) contentParts.push(`== Discord（繁中服）プレイヤーのディスカッション ==\n${groupRecordsByTag(discordRecords.slice(0, 15), 'D', false)}`);
  if (hasLounge) contentParts.push(`== 韓国 Lounge プレイヤーのディスカッション ==\n${groupRecordsByTag(loungeRecords.slice(0, 15), 'K', false)}`);
  const content = contentParts.join('\n\n');
  
  // 番号の説明の構築
  const idDesc = [
    hasTwitter ? '[T番号]=Twitter日服発言' : '',
    hasDiscord ? '[D番号]=Discord繁中服発言' : '',
    hasLounge ? '[K番号]=韓国Lounge発言' : ''
  ].filter(Boolean).join('、');
  
  // 返却フォーマットの例の構築
  const returnExample = [];
  if (hasTwitter) returnExample.push(`"twitter_topics": [{ "title": "SSRドロップ率の議論", "summary": "複数のプレイヤーが100ガチャでゼロSSRを報告", "detail": "3人のプレイヤーが80-120ガチャでゼロSSRを経験した...", "sentiment": "negative", "tag": "gacha", "action": "実際のドロップ率データを公開する", "count": 3, "representative_quotes": [{"text": "100ガチャしてもゼロ", "created_at": "2026/6/17 14:30"}], "urls": ["https://twitter.com/xxx/status/123"] }]`);
  if (hasDiscord) returnExample.push(`"discord_topics": [同上フォーマット]`);
  if (hasLounge) returnExample.push(`"lounge_topics": [同上フォーマット]`);
  
  const prompt = `你是《森の国度》(ツリネバ/TOS Neverland) 游戏の资深運営アナリスト。

以下是プレイヤーのリアルな発言、既にトピック別に分類されています。${idDesc}。

ゲーム背景：
- ツリーボンド：コアソーシャルペアリングシステム
- 騎士団/騎士団戦：ギルドとギルド戦プレイ
- マッドセイドン：リミテッドチャレンジイベント
- ガチャ：ガチャシステム
- IPライセンス：リュシイムタエンと韓国原産とのコラボレーション関係

❗❗❗ コア要件（遵守しなければならない）：

1. **summary 必須具体的**：2-3文でプレイヤーが何について話しているか、なぜ話しているか、诉求は何かを説明する
   ❌ 間違いの例："プレイヤーがガチャ問題を抱怨している"
   ✅ 正しい例："複数のプレイヤーがSSRドロップ率が低すぎると言っている、100ガチャでゼロSSRの人がいる、保証メカニズムが透明でないと思われている"

2. **detail フィールド**：3-5文で分析を展開する：
   - 具体なことが起きた（イベントの説明）
   - プレイヤーのコアな感情と要求
   - 影響範囲（どのプレイヤー、どのプレイ）
   - 潜在的なリスク（発酵する可能性、課金に関連しているかどうか）

3. **representative_quotes 必須ある**：1-2文のプレイヤーの原語を直接引用（偽造しない）
   オブジェクト配列の形式：[{"text": "プレイヤーの原語", "created_at": "2026/6/17 14:30"}]
   created_at は元データから取得し、YYYY/MM/DD HH:mm の形式

4. **urls 必須ある**：元データの url フィールドから抽出し、各トピックには少なくとも1つの代表的な発言のリンク（文字列配列）

5. **1件以上の議論があるタグごとにトピックを生成**、1件しかない場合は「その他」に分類する

6. **感情判断**：positive(称賛/期待) / neutral(ディスカッション/質問) / negative(抱怨/批評)

7. **検索ワードをフィルタリング**："ツリネバ"はゲーム名/Yahoo検索ワードであり、すべての行に含まれていますので、ホットトピックにはならない。同様に"TOSN""TOSNeverland"も該当しない。

8. **❗❗ 運営関連の内容はスキップ（トピックを生成しない）**：
   プレイヤーが「運営/營運/運営/カスタマーサポート/公式態度/公式信用/公式返答/GM管理」などの運営チームに関する内容をコアとして議論している場合、**スキップし、トピックを生成しない**。
   判断基準：トピックのコアな要求が運営チームの行動、態度、信用、コミュニケーション方法に対する批評や不満である。
   注意：ゲームメカニズムの問題（バグ、バランス調整など）であっても、プレイヤーが「公式」と言及していても、運営トピックにはならないので、通常通り生成する。

9. **❗❗ tag は以下の固定リストから選択する（カスタムは許可しない）**：
   - bug_report (Bug/問題フィードバック)
   - gacha (ガチャ)
   - knight_order (騎士団/ギルド)
   - tree_bond (ツリーボンドシステム)
   - event (イベント/マッドセイドン)
   - cosmetic (衣装/スキン)
   - world_boss (ワールドボス)
   - photo (撮影機能)
   - pricing (課金/価格)
   - server (サーバー/合併)
   - social (ソーシャルインタラクション)
   - gameplay_balance (ゲームバランス)
   - general (その他のディスカッション)

返却 JSON フォーマット（熱度はシステムコードによって計算され、返却しない）：
{
  ${returnExample.join(',\n  ')}
}`;

  const result = await callAI(prompt, content, { maxTokens: 3000, jsonMode: true });
  
  if (!result) {
    console.log('⚠️ 多プラットフォーム AI 失敗、降格してそれぞれ分析');
    const [tw, dc, lg] = await Promise.all([
      hasTwitter ? aiSummarizeHotTopics(twitterRecords) : Promise.resolve([]),
      hasDiscord ? aiSummarizeHotTopics(discordRecords) : Promise.resolve([]),
      hasLounge ? aiSummarizeHotTopics(loungeRecords) : Promise.resolve([])
    ]);
    const finalResult = {
      twitter_topics: tw,
      discord_topics: dc,
      lounge_topics: lg
    };
    cacheIfHasTopics(finalResult);
    return finalResult;
  }
  
  try {
    let parsed = safeJsonParse(result, '多プラットフォームトピック');
    if (!parsed) {
      const m = result.match(/\{[\s\S]*\}/);
      if (m) parsed = safeJsonParse(m[0], '多プラットフォームトピック-抽出');
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
      
      // 代码校验：按 topic_tag で実際の count を再集計し、AIの count を上書き
      const realCounts = {};
      const allRecords = [...(twitterRecords||[]), ...(discordRecords||[]), ...(loungeRecords||[])];
      for (const r of allRecords) {
        const tag = r.topic_tag || 'general';
        realCounts[tag] = (realCounts[tag] || 0) + 1;
      }
      
      const applyRealCounts = (topics) => topics.map(t => {
        const realCount = realCounts[t.tag] || t.count;
        return { ...t, count: realCount, heat: calculateHeat(realCount, t.sentiment, t.tag) };
      });
      
      const filterOps = (topics) => topics.filter(t => !isOperationsTopic(t));
      const finalResult = {
        twitter_topics: hasTwitter ? filterOps(applyRealCounts(deduplicateTopics((parsed.twitter_topics || []).map(mapTopic)))) : [],
        discord_topics: hasDiscord ? filterOps(applyRealCounts(deduplicateTopics((parsed.discord_topics || []).map(mapTopic)))) : [],
        lounge_topics: hasLounge ? filterOps(applyRealCounts(deduplicateTopics((parsed.lounge_topics || []).map(mapTopic)))) : []
      };
      cacheIfHasTopics(finalResult);
      return finalResult;
    }
  } catch (e) {
    console.warn('⚠️ 多プラットフォームトピック解析に失敗:', e.message);
  }
  
  // 降格結果はキャッシュしない
  return {
    twitter_topics: fallbackTopicExtraction(twitterRecords || []),
    discord_topics: fallbackTopicExtraction(discordRecords || []),
    lounge_topics: fallbackTopicExtraction(loungeRecords || [])
  };
}

/**
 * 降格方案：キーワード頻度に基づいたトピック抽出（簡易版）
 */
function fallbackTopicExtraction(records) {
  const topicMap = {};
  // 検索ワードブラックリスト：これらはYahoo検索キーワードであり、すべての行に含まれているので、ホットトピックにはならない
  const blacklist = ['ツリネバ', 'tosn', 'tosneverland', 'tos neverland'];
  
  for (const record of records) {
    const keywords = record.keywords ? 
      (Array.isArray(record.keywords) ? record.keywords : record.keywords.split(',')) : [];
    
    for (const kw of keywords) {
      if (!kw || kw.trim().length < 2) continue;
      const normalizedKw = kw.trim().toLowerCase();
      if (blacklist.includes(normalizedKw)) continue; // 検索ワードをスキップ
      if (!topicMap[normalizedKw]) topicMap[normalizedKw] = { count: 0 };
      topicMap[normalizedKw].count++;
    }
  }
  
  return Object.entries(topicMap)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([title, data]) => ({
      title,
      summary: `共有 ${data.count} 件の関連ディスカッション`,
      heat: calculateHeat(data.count, 'neutral', ''),
      sentiment: 'neutral',
      tag: 'general',
      action: '',
      count: data.count
    }));
}

/**
 * AI 哨兵：'general' バケットから新しいトピッククラスタを発見する
 * 毎日実行し、自動的に要約し、自動的に保存し、手動確認不要
 * 
 * @param {Array} generalRecords - topic_tag が 'general' の発言レコード
 * @returns {Promise<Array>} 新しく見つけたトピック（tag には auto_ プレフィックス）
 */
async function aiScoutNewTopics(generalRecords) {
  if (!generalRecords || generalRecords.length < 3) {
    return [];  // 3件未満は分析しない、意味がない
  }
  
  console.log(`🔍 AI 哨兵: ${generalRecords.length} 件の'その他のディスカッション'を分析し、新しいトピックを検出...`);
  
  // コンテンツの準備
  const lines = generalRecords.slice(0, 20).map((r, i) => {
    const text = (r.translated_content || r.content || '').substring(0, 120);
    const url = r.url ? ` (リンク:${r.url})` : '';
    return `[${i + 1}] ${text}${url}`;
  });
  const content = lines.join('\n');
  
  const knownTags = 'bug_report, gacha, knight_order, tree_bond, event, cosmetic, world_boss, photo, pricing, server, social, gameplay_balance, general';
  
  const prompt = `你是《森の国度》ゲームの舆情アナリスト。

以下は既知の分類（${knownTags}）に属さないプレイヤーの発言です。

新しいトピックが集約されているかどうかを判断してください。つまり、複数の発言が同じ新しい内容（新しいシステム、新しいイベント、新しいコラボなど）について話しているかどうかです。

要件：
1. 明らかに集約されたトピックのみを返す（少なくとも3つの発言が同じことを話している）
2. 明確な新しいトピッククラスタがない場合は、空配列 [] を返す
3. 各新しいトピックを2-3文で要約する。具体的でなければなりません
4. representative_quotes はプレイヤーの原語を直接引用する（偽造しない）
5. urls は元データから抽出する
6. tag は英語の snake_case で、新しいトピックを簡潔に説明する（例：pet_system, arena, collab）

返却 JSON 配列：
[{
  "title": "ペットシステム期待",  // 中文タイトル
  "summary": "複数のプレイヤーが近々リリースされるペットシステムについて...",  // 2-3文具体的な説明
  "sentiment": "positive",
  "tag": "pet_system",
  "count": 5,
  "representative_quotes": [{"text": "プレイヤーの原語", "created_at": "2026/6/10 14:30"}],
  "urls": ["https://..."]
}]

新しいトピッククラスタが見つからない場合は、[]`;
  
  const result = await callAI(prompt, content, { maxTokens: 1000, jsonMode: true });
  
  if (!result) {
    console.log('   🔍 AI 哨兵: 呼び出しに失敗、スキップ');
    return [];
  }
  
  try {
    let parsed = safeJsonParse(result, 'AI哨兵');
    if (!parsed) {
      const m = result.match(/\[[\s\S]*\]/);
      if (m) parsed = safeJsonParse(m[0], 'AI哨兵-抽出');
    }
    
    if (Array.isArray(parsed) && parsed.length > 0) {
      const topics = parsed.map(t => ({
        title: t.title || '未命名',
        summary: t.summary || '',
        detail: t.summary || '',  // 哨兵モードでは summary が detail
        sentiment: t.sentiment || 'neutral',
        tag: `auto_${(t.tag || 'new').replace(/^auto_/, '')}`,  // auto_ プレフィックスを強制
        action: '',
        count: t.count || 0,
        heat: calculateHeat(t.count || 0, t.sentiment || 'neutral', ''),
        representative_quotes: t.representative_quotes || [],
        urls: t.urls || []
      }));
      console.log(`   🆕 AI 哨兵: ${topics.length} 件の新しいトピックを発見`);
      topics.forEach(t => console.log(`      - ${t.tag}: ${t.title} (${t.count}件)`));
      return topics;
    } else {
      console.log('   🔍 AI 哨兵: 新しいトピッククラスタが見つからない');
    }
  } catch (e) {
    console.warn('   ⚠️ AI 哨兵解析に失敗:', e.message);
  }
  
  return [];
}

/**
 * 七日热门话题 AI 概述（各トピックに対して実際の summary を生成する）
 * @param {Object} topicsByTag - { tag: { messages: [...], count, neg, pos, neu } }
 * @param {string} platform - 'twitter' | 'discord'
 * @returns {Object} - { tag: aiSummary } 各トピックの AI 概要
 */
let weeklySummaryCache = { result: null, lastUpdated: 0, recordCount: 0 };

async function aiSummarizeWeeklyTopics(topicsByTag, platform) {
  const tags = Object.keys(topicsByTag);
  if (tags.length === 0) return {};
  
  // キャッシュチェック（2時間有効）
  const totalMessages = tags.reduce((sum, tag) => sum + (topicsByTag[tag].count || 0), 0);
  const now = Date.now();
  if (weeklySummaryCache.result && 
      weeklySummaryCache.platform === platform &&
      (now - weeklySummaryCache.lastUpdated) < 2 * 60 * 60 * 1000 &&
      Math.abs(totalMessages - weeklySummaryCache.recordCount) < 5) {
    console.log('📦 使用七日トピック AI キャッシュ（2時間以内）');
    return weeklySummaryCache.result;
  }
  
  const platformName = platform === 'twitter' ? 'Twitter（日服）' : platform === 'discord' ? 'Discord（繁中服）' : 'Naver（韩服）';
  
  // 入力の構築：各トピックから最大8件の代表的な発言を取得
  let content = '';
  for (const tag of tags) {
    const { messages, count } = topicsByTag[tag];
    const samples = messages.slice(0, 8);
    content += `\n【${tag}】(${count}件のディスカッション)\n`;
    for (let i = 0; i < samples.length; i++) {
      const m = samples[i];
      const text = m.translated_content || m.content || '';
      const url = m.url ? ` [リンク:${m.url}]` : '';
      content += `  ${i+1}. "${text.substring(0, 150)}"${url}\n`;
    }
  }
  
  const prompt = `你是《森の国度》(ツリネバ/TOS Neverland) 游戏のコミュニティ運営アナリスト。

以下は${platformName}プレイヤーの7日間のディスカッションで、既にトピック別に分類されています。

ゲーム背景：
- ツリーボンド：コアソーシャルペアリングシステム
- 騎士団/騎士団戦：ギルドとギルド戦プレイ
- マッドセイドン：リミテッドチャレンジイベント
- ガチャ：ガチャシステム

❗❗ 核心要件：

1. 各トピックに対して **summary**（要約）を生成する：
   - 2-3文でプレイヤーが何について話しているか、なぜ話しているか、コアな要求は何かを説明する
   - ❌ 間違いの例："プレイヤーが騎士団について話している"
   - ✅ 正しい例："複数のプレイヤーが騎士団戦のランキング経験を共有し、ポイントメカニズムと花御の育成戦略について議論し、一部のプレイヤーが1位にならなかったことに残念を表している"

2. JSONオブジェクトを返却する。キーはトピックのtag、値は要約文字列：
{
  "knight_order": "2-3文の要約",
  "gacha": "2-3文の要約",
  ...
}

他の内容は返却しない。`;

  console.log(`🤖 AI 7日間トピックの要約を生成（${platformName}、${tags.length}件のトピック）`);
  const result = await callAI(prompt, content, { maxTokens: 1200, jsonMode: true });
  
  if (!result) {
    console.warn('⚠️ 7日間トピック AI 要約に失敗');
    return {};
  }
  
  try {
    let parsed = safeJsonParse(result, '7日間トピックの要約');
    if (!parsed) {
      const m = result.match(/\{[\s\S]*\}/);
      if (m) parsed = safeJsonParse(m[0], '7日間トピックの要約-抽出');
    }
    if (parsed && typeof parsed === 'object') {
      weeklySummaryCache = { result: parsed, lastUpdated: now, recordCount: totalMessages, platform };
      return parsed;
    }
  } catch (e) {
    console.warn('⚠️ 7日間トピックの要約解析に失敗:', e.message);
  }
  
  return {};
}

module.exports = {
  aiAnalyzeSentiment,
  aiExtractTopics,
  aiGenerateSummary,
  aiClassifyFeedback,
  aiSummarizeHotTopics,
  aiSummarizeHotTopicsDual,  // 多プラットフォーム一次性分析
  aiSummarizeWeeklyTopics,   // 七日热门话题AI概述
  batchAnalyze,
  clearTopicCache,           // トピックキャッシュのクリア
  standardizeTag,            // tag 標準化（グローバル唯一入口）
  aiScoutNewTopics,          // AI 哨兵：'general' バケットから新しいトピックを検出
};

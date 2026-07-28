/**
 * 游戏术语模块 — 加载、索引、搜索、文本术语提取
 * 数据来自 terminology-tool/data/terms.json（10万+条）
 * 每条格式: [中文, 日语, 英语, 韩语, 繁中, 越南语, 印尼语, 泰语, 分类, 子分类1, 子分类2]
 */

const fs = require('fs');
const path = require('path');

const LANG_KEYS = ['jp', 'en', 'kr', 'tw', 'vn', 'id', 'th'];
const TERMS_FILE = path.join(__dirname, 'terminology-tool', 'data', 'terms.json');
const VERSION_FILE = path.join(__dirname, 'terminology-tool', 'data', 'version.json');

let TERMS = [];
let INDEX = {};       // 搜索索引: normalized_text -> Set<term_index>
let VERSION_INFO = null;

// ===== 初始化：加载数据 + 建索引 =====
function init() {
  try {
    const raw = fs.readFileSync(TERMS_FILE, 'utf8');
    TERMS = JSON.parse(raw);
    console.log(`📖 术语库加载成功: ${TERMS.length} 条`);
  } catch (e) {
    console.error('❌ 术语库加载失败:', e.message);
    return;
  }

  try {
    VERSION_INFO = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch (_) {}

  buildIndex();
}

function normalize(s) {
  return (s || '').replace(/[（）]/g, c => c === '（' ? '(' : ')');
}

function buildIndex() {
  INDEX = {};
  for (let i = 0; i < TERMS.length; i++) {
    const t = TERMS[i];
    // 中文建索引
    addIdx(t[0], i, true);
    // 7种语言建索引
    for (let li = 0; li < LANG_KEYS.length; li++) {
      const text = t[li + 1];
      if (text) {
        text.split(' | ').forEach(p => addIdx(p.trim(), i, false));
      }
    }
  }
  console.log(`📖 术语索引建好: ${Object.keys(INDEX).length} 个索引键`);
}

function addIdx(text, idx, isCn) {
  if (!text || text.length < 2) return;
  if (isCn && text.length > 10) return;
  if (/[<！？。，]/.test(text)) return;
  const n = normalize(text);
  if (!INDEX[n]) INDEX[n] = new Set();
  INDEX[n].add(idx);
}

// ===== 搜索术语 =====
function searchTerms(query, limit = 50) {
  if (!query || query.length < 1) return [];
  const q = normalize(query);
  const results = [];
  const seen = new Set();

  // 精确匹配
  if (INDEX[q]) {
    for (const i of INDEX[q]) {
      if (results.length >= limit) break;
      results.push(i);
      seen.add(i);
    }
  }

  // 模糊匹配（中文包含关键词）
  for (let i = 0; i < TERMS.length && results.length < limit; i++) {
    if (seen.has(i)) continue;
    const cn = TERMS[i][0];
    if (cn && cn.toLowerCase().includes(q.toLowerCase())) {
      results.push(i);
      seen.add(i);
    }
  }

  // 模糊匹配（其他语言包含关键词）
  for (let i = 0; i < TERMS.length && results.length < limit; i++) {
    if (seen.has(i)) continue;
    for (let li = 0; li < LANG_KEYS.length; li++) {
      const text = TERMS[i][li + 1];
      if (text && text.toLowerCase().includes(q.toLowerCase())) {
        results.push(i);
        seen.add(i);
        break;
      }
    }
  }

  return results.map(i => ({
    zh: TERMS[i][0],
    ja: TERMS[i][1] || '',
    en: TERMS[i][2] || '',
    ko: TERMS[i][3] || '',
    'zh-tw': TERMS[i][4] || '',
    vi: TERMS[i][5] || '',
    id: TERMS[i][6] || '',
    th: TERMS[i][7] || '',
    category: TERMS[i][8] || '',
    subCategory1: TERMS[i][9] || '',
    subCategory2: TERMS[i][10] || '',
  }));
}

// ===== 从日语文本中提取命中的术语（给翻译用）=====
// 返回 [{jp: "日语原文", cn: "中文译法"}, ...]
function findTermsInText(text, maxTerms = 30) {
  if (!text || !TERMS.length) return [];
  const found = [];
  const seen = new Set();

  // 按日语术语长度从长到短排序（优先匹配长术语，避免短术语误匹配）
  const jpTerms = [];
  for (let i = 0; i < TERMS.length; i++) {
    const jp = TERMS[i][1];
    if (jp && jp.length >= 2) {
      jpTerms.push({ jp, cn: TERMS[i][0], idx: i });
    }
  }
  jpTerms.sort((a, b) => b.jp.length - a.jp.length);

  for (const { jp, cn, idx } of jpTerms) {
    if (found.length >= maxTerms) break;
    if (seen.has(idx)) continue;
    if (text.includes(jp)) {
      seen.add(idx);
      const t = TERMS[idx];
      found.push({ ja: jp, zh: t[0], en: t[2] || '', ko: t[3] || '', 'zh-tw': t[4] || '' });
    }
  }

  return found;
}

// ===== 统计信息 =====
function getStats() {
  return {
    total: TERMS.length,
    version: VERSION_INFO ? VERSION_INFO.version : '',
    languages: LANG_KEYS,
  };
}

module.exports = {
  init,
  searchTerms,
  findTermsInText,
  getStats,
  LANG_KEYS,
};

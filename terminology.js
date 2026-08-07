/**
 * 游戏术语模块 — 加载、索引、搜索、文本术语提取、批量校对、术语更新
 * 数据来自 terminology-tool/data/terms.json（10万+条）
 * 每条格式: [中文, 日语, 英语, 韩语, 繁中, 越南语, 印尼语, 泰语, 分类, 子分类1, 子分类2]
 */

const fs = require('fs');
const path = require('path');

const LANG_KEYS = ['jp', 'en', 'kr', 'tw', 'vn', 'id', 'th'];
const LANG_LABELS = { jp: '日语', en: '英语', kr: '韩语', tw: '繁中', vn: '越南语', id: '印尼语', th: '泰语' };
const TERMS_FILE = path.join(__dirname, 'terminology-tool', 'data', 'terms.json');
const VERSION_FILE = path.join(__dirname, 'terminology-tool', 'data', 'version.json');

let TERMS = [];
let INDEX = {};       // 搜索索引: normalized_text -> Set<term_index>
let VERSION_INFO = null;

// 缓存：按语言分组的术语列表（避免每次校对都重建+排序）
let LANG_TERMS_CACHE = {};  // { jp: [{text, cn, idx}], ... }

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
  LANG_TERMS_CACHE = {};
  for (let i = 0; i < TERMS.length; i++) {
    const t = TERMS[i];
    // 中文建索引
    addIdx(t[0], i, true);
    // 为中文明语建立缓存（用于模糊匹配）
    if (t[0] && t[0].length >= 2) {
      if (!LANG_TERMS_CACHE['cn']) LANG_TERMS_CACHE['cn'] = [];
      LANG_TERMS_CACHE['cn'].push({ text: t[0], cn: t[0], idx: i });
    }
    // 7种语言建索引 + 缓存
    for (let li = 0; li < LANG_KEYS.length; li++) {
      const langKey = LANG_KEYS[li];
      const text = t[li + 1];
      if (text) {
        text.split(' | ').forEach(p => {
          const trimmed = p.trim();
          addIdx(trimmed, i, false);
          // 为每种语言缓存术语列表（校对用）
          if (trimmed.length >= 2) {
            if (!LANG_TERMS_CACHE[langKey]) LANG_TERMS_CACHE[langKey] = [];
            LANG_TERMS_CACHE[langKey].push({ text: trimmed, cn: t[0], idx: i });
          }
        });
      }
    }
  }
  // 按术语长度从长到短排序（长术语优先匹配，避免短词误命中）
  for (const lang of LANG_KEYS) {
    if (LANG_TERMS_CACHE[lang]) {
      LANG_TERMS_CACHE[lang].sort((a, b) => b.text.length - a.text.length);
    }
  }
  console.log(`📖 术语索引建好: ${Object.keys(INDEX).length} 个索引键, 语言缓存: ${Object.keys(LANG_TERMS_CACHE).map(k => k + '=' + LANG_TERMS_CACHE[k].length).join(', ')}`);
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
    jp: TERMS[i][1] || '',
    en: TERMS[i][2] || '',
    kr: TERMS[i][3] || '',
    tw: TERMS[i][4] || '',
    vn: TERMS[i][5] || '',
    id: TERMS[i][6] || '',
    th: TERMS[i][7] || '',
    category: TERMS[i][8] || '',
    subCategory1: TERMS[i][9] || '',
    subCategory2: TERMS[i][10] || '',
  }));
}

// ===== 从文本中提取命中的术语（校对用）=====
// lang: 'jp'/'en'/'kr' 等，或 'auto' 自动扫描所有语言
function findTermsInText(text, maxTerms = 50, lang = 'auto') {
  if (!text || !TERMS.length) return [];
  const found = [];
  const seen = new Set();

  // 决定要搜索哪些语言列表
  let langsToSearch = [];
  if (lang && lang !== 'auto' && LANG_TERMS_CACHE[lang]) {
    langsToSearch = [lang];
  } else {
    // 自动模式：扫描所有语言
    langsToSearch = LANG_KEYS;
  }

  // 第一优先级：精确匹配（完全一致）
  for (const lk of langsToSearch) {
    if (found.length >= maxTerms) break;
    const langList = LANG_TERMS_CACHE[lk] || [];
    for (const { text: termText, cn, idx } of langList) {
      if (found.length >= maxTerms) break;
      if (seen.has(idx)) continue;
      if (text.includes(termText)) {
        seen.add(idx);
        const t = TERMS[idx];
        const result = { matched: termText, zh: t[0], matchType: 'exact' };
        for (let li = 0; li < LANG_KEYS.length; li++) {
          result[LANG_KEYS[li]] = t[li + 1] || '';
        }
        result.category = t[8] || '';
        found.push(result);
      }
    }
  }

  // 第二优先级：关键词匹配（模糊匹配）
  // ⚠️ 注意：只在中文（cn）语言缓存中搜索，避免重复匹配
  if (!langsToSearch.includes('cn')) {
    langsToSearch.unshift('cn');
  }
  
  for (const lk of langsToSearch) {
    if (found.length >= maxTerms) break;
    const langList = LANG_TERMS_CACHE[lk] || [];
    for (const { text: termText, cn, idx } of langList) {
      if (found.length >= maxTerms) break;
      if (seen.has(idx)) continue;
      
      // 计算术语的关键词覆盖率
      const keywords = extractKeywords(termText); // ['自选', '选套', ...]
      if (keywords.length >= 2) {
        const hitCount = keywords.filter(kw => text.includes(kw)).length;
        const coverage = hitCount / keywords.length;
        
        // 50% 以上的关键词命中就算匹配（允许错一个字）
        if (coverage >= 0.7) {
          seen.add(idx);
          const t = TERMS[idx];
          const result = { matched: termText, zh: t[0], matchType: 'fuzzy', coverage };
          for (let li = 0; li < LANG_KEYS.length; li++) {
            result[LANG_KEYS[li]] = t[li + 1] || '';
          }
          result.category = t[8] || '';
          found.push(result);
        }
      }
    }
  }

  // 按匹配术语长度从长到短排序（长术语更精准），同长度时精确匹配优先
  found.sort((a, b) => {
    if (b.matched.length !== a.matched.length) return b.matched.length - a.matched.length;
    if (a.matchType === 'exact' && b.matchType !== 'exact') return -1;
    if (a.matchType !== 'exact' && b.matchType === 'exact') return 1;
    return 0;
  });
  return found;
}

// ===== 提取关键词：将术语拆分为有意义的子串 =====
function extractKeywords(term) {
  if (!term || term.length < 2) return [term];
  
  // 方案 1：中文分词（简单按双字窗口滑动）
  const bigrams = [];
  for (let i = 0; i <= term.length - 2; i++) {
    bigrams.push(term.substring(i, i + 2));
  }
  
  // 方案 2：保留完整术语（如果较短）
  if (term.length <= 4) {
    return [term, ...bigrams];
  }
  
  // 方案 3：长术语只返回 bigrams
  return bigrams;
}

// ===== 批量校对：逐行检查术语命中 =====
function batchCheck(lines, lang = 'jp') {
  if (!lines || !lines.length || !TERMS.length) return [];
  const langList = LANG_TERMS_CACHE[lang] || [];

  return lines.map((line, i) => {
    const hits = [];
    const seen = new Set();
    for (const { text: termText, cn, idx } of langList) {
      if (seen.has(idx)) continue;
      if (line.includes(termText)) {
        seen.add(idx);
        const t = TERMS[idx];
        const hit = { matched: termText, zh: t[0], category: t[8] || '' };
        for (let li = 0; li < LANG_KEYS.length; li++) {
          hit[LANG_KEYS[li]] = t[li + 1] || '';
        }
        hits.push(hit);
      }
    }
    return { line: i + 1, text: line.substring(0, 120), hits: hits.length, terms: hits.slice(0, 10) };
  });
}

// ===== 合并更新术语（从前端解析的 Excel 数据）=====
function mergeTerms(updates) {
  // updates: [{ cn, jp, en, kr, tw, vn, id, th, category, key, note }]
  let added = 0, updated = 0;
  const cnIndex = {};
  for (let i = 0; i < TERMS.length; i++) cnIndex[TERMS[i][0]] = i;

  for (const u of updates) {
    if (!u.cn || u.cn.length > 30) continue;
    const existIdx = cnIndex[u.cn];
    if (existIdx !== undefined) {
      // 更新已有术语
      const t = TERMS[existIdx];
      for (let li = 0; li < LANG_KEYS.length; li++) {
        const newVal = u[LANG_KEYS[li]];
        if (newVal) {
          const existing = t[li + 1] || '';
          if (!existing.split(' | ').includes(newVal)) {
            t[li + 1] = existing ? existing + ' | ' + newVal : newVal;
          }
        }
      }
      if (u.category) t[8] = u.category;
      if (u.key) t[9] = u.key;
      if (u.note) t[10] = u.note;
      updated++;
    } else {
      // 新增术语
      const row = [u.cn];
      for (let li = 0; li < LANG_KEYS.length; li++) {
        row.push(u[LANG_KEYS[li]] || '');
      }
      row.push(u.category || '', u.key || '', u.note || '');
      TERMS.push(row);
      cnIndex[u.cn] = TERMS.length - 1;
      added++;
    }
  }

  // 重建索引
  buildIndex();
  // 保存回文件
  try {
    fs.writeFileSync(TERMS_FILE, JSON.stringify(TERMS), 'utf8');
    // 更新版本号
    const now = new Date();
    const ver = String(now.getFullYear()).slice(2) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    VERSION_INFO = { version: ver, count: TERMS.length, languages: LANG_KEYS };
    fs.writeFileSync(VERSION_FILE, JSON.stringify(VERSION_INFO, null, 2), 'utf8');
  } catch (e) {
    console.error('术语保存失败:', e.message);
  }

  return { added, updated, total: TERMS.length };
}

// ===== 统计信息 =====
function getStats() {
  return {
    total: TERMS.length,
    version: VERSION_INFO ? VERSION_INFO.version : '',
    languages: LANG_KEYS,
  };
}

// ===== 添加到术语库（手动新增） =====
function addTerm(termData) {
  const { zh, jp, en, kr, tw, vn, id, th } = termData;
  
  // 查重：检查中文是否已存在
  for (let i = 0; i < TERMS.length; i++) {
    if (TERMS[i][0] && TERMS[i][0].trim().toLowerCase() === zh.trim().toLowerCase()) {
      throw new Error(`术语 "${zh}" 已存在于第 ${i + 1} 行`);
    }
  }
  
  // 添加到数组末尾
  const newIndex = TERMS.length;
  TERMS.push([zh, jp || '', en || '', kr || '', tw || '', vn || '', id || '', th || '', '待分类', '', '']);
  
  // 更新版本信息
  try {
    VERSION_INFO = {
      version: `${TERMS.length}条-${new Date().toISOString().split('T')[0]}`,
      lastUpdate: new Date().toISOString(),
      addedBy: termData._addedBy || 'unknown'
    };
    fs.writeFileSync(VERSION_FILE, JSON.stringify(VERSION_INFO, null, 2));
  } catch (e) {
    console.error('[版本信息写入失败]', e.message);
  }
  
  // 重新建索引（增量加，不需要全量重建）
  addIdx(zh, newIndex, true);
  
  // 保存文件（防止丢失）
  saveTermsToFile();
  
  console.log(`✅ 已添加术语: "${zh}" → #${newIndex + 1}`);
  
  return {
    index: newIndex,
    term: [zh, jp, en, kr, tw, vn, id, th]
  };
}

// 保存到文件
function saveTermsToFile() {
  try {
    fs.writeFileSync(TERMS_FILE, JSON.stringify(TERMS, null, 2), 'utf8');
  } catch (e) {
    console.error('[保存术语库失败]', e.message);
    throw e;
  }
}

module.exports = {
  init,
  searchTerms,
  findTermsInText,
  batchCheck,
  mergeTerms,
  addTerm,
  getStats,
  LANG_KEYS,
  LANG_LABELS,
};

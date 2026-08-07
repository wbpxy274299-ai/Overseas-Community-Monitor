/**
 * 贴文助手 — AI Studio + DeepSeek 双引擎版
 * 左栏：AI Studio 聊天窗（iframe 直嵌，内网环境）
 * 右栏：编辑器 + DeepSeek 翻译/校对
 * 特性：翻译结果缓存 1 自然天，切换页面不丢失
 */

const LANG_LABELS = { jp: '日语', en: '英语', kr: '韩语', tw: '繁中', vn: '越南语', id: '印尼语', th: '泰语' };
const LANG_EMOJI = { jp: '🇯🇵', en: '🇬🇧', kr: '🇰🇷', tw: '🇭🇰', vn: '🇻🇳', id: '🇮🇩', th: '🇹🇭' };

// ===== 工具函数 =====
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ===== 缓存机制（localStorage，1 自然天过期） =====
const PA_CACHE_PREFIX = 'pa_trans_';

function _paCacheKey(text) {
  // 用文本长度 + 前100字符做简易 hash
  return PA_CACHE_PREFIX + text.length + '_' + text.substring(0, 100).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
}

function _paSaveCache(text, translations) {
  try {
    localStorage.setItem(_paCacheKey(text), JSON.stringify({
      text,
      translations,
      ts: Date.now(),
      date: new Date().toDateString()
    }));
  } catch (e) { /* localStorage 满了就忽略 */ }
}

function _paLoadCache(text) {
  try {
    const raw = localStorage.getItem(_paCacheKey(text));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    // 检查是否是同一天
    if (entry.date === new Date().toDateString()) {
      return entry.translations;
    }
    // 过期，删除
    localStorage.removeItem(_paCacheKey(text));
    return null;
  } catch { return null; }
}

function _paLoadLatestCache() {
  // 找到最新的未过期缓存
  try {
    const today = new Date().toDateString();
    let latest = null;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PA_CACHE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const entry = JSON.parse(raw);
      if (entry.date === today && (!latest || entry.ts > latest.ts)) {
        latest = entry;
      } else if (entry.date !== today) {
        localStorage.removeItem(key); // 清理过期
      }
    }
    return latest;
  } catch { return null; }
}

// ===== Tab 切换 =====
function paSwitchTab(tab) {
  document.querySelectorAll('.seg-bar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.adm-sub').forEach(c => c.classList.remove('on'));
  document.getElementById('pa-tab-' + tab).classList.add('on');
}

// ===== 清空 =====
function paClear() {
  document.getElementById('pa-editor').value = '';
  document.getElementById('pa-status').textContent = '';
  document.getElementById('pa-output').innerHTML = '<div class="pa-empty-hint">翻译结果会显示在这里 ✨</div>';
  document.getElementById('pa-proof-output').innerHTML = '<div class="pa-empty-hint">校对结果会显示在这里 📝</div>';
  document.getElementById('pa-term-report').style.display = 'none';
  window._paTranslations = null;
  window._paTermCache = null; // 清除术语缓存
  paSwitchTab('translate');
}

// ===== 第一阶段：显示术语使用报告 =====
function _paShowTermReport(results) {
  const reportEl = document.getElementById('pa-term-report');
  const listEl = document.getElementById('pa-term-list');
  
  if (!results || results.length === 0) {
    reportEl.style.display = 'none';
    return;
  }
  
  // 统计精确匹配 vs 模糊匹配
  const exactMatch = results.filter(r => !r.matchType || r.matchType === 'exact');
  const fuzzyMatch = results.filter(r => r.matchType === 'fuzzy');
  
  let html = `<div style="margin-bottom:6px;font-size:11px;color:var(--mut)">`;
  html += `共匹配 <strong style="color:var(--ink)">${results.length}</strong> 个游戏术语`;
  html += `（<span style="color:#10b981">✅ 精确 ${exactMatch.length}</span>`;
  html += `, <span style="color:#f59e0b">🔍 模糊 ${fuzzyMatch.length}</span>）`;
  html += `</div>`;
  
  // 显示前 10 个术语
  html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">';
  results.slice(0, 10).forEach(r => {
    const badgeColor = r.matchType === 'exact' ? '#10b981' : '#f59e0b';
    const typeLabel = r.matchType === 'exact' ? '✅' : '🔍';
    html += `<span style="display:inline-block;padding:2px 8px;background:var(--panel-3);border-radius:4px;font-size:11px;border-left:2px solid ${badgeColor}">${typeLabel} ${esc(r.matched)}</span>`;
  });
  if (results.length > 10) {
    html += `<span style="font-size:11px;color:var(--mut)">...还有 ${results.length - 10} 个</span>`;
  }
  html += '</div>';
  
  listEl.innerHTML = html;
  reportEl.style.display = 'block';
}

// ===== 翻译 7 语言（DeepSeek + 术语注入） =====
async function paTranslate() {
  const text = document.getElementById('pa-editor').value.trim();
  if (!text) return Toast.warning('请先在编辑区输入贴文内容');

  // 先检查缓存
  const cached = _paLoadCache(text);
  if (cached) {
    window._paTranslations = cached;
    renderTranslations(cached, document.getElementById('pa-output'));
    document.getElementById('pa-status').textContent = '✅ 已恢复缓存的翻译结果（今日有效）';
    paSwitchTab('translate');
    return;
  }

  const out = document.getElementById('pa-output');
  const proofOut = document.getElementById('pa-proof-output');
  const btn = document.getElementById('pa-trans-btn');
  const status = document.getElementById('pa-status');
  btn.disabled = true;
  status.textContent = '⏳ 正在翻译为 7 种语言...';

  try {
    // 第一阶段：规则匹配（术语使用报告）
    const termRes = await fetch(`/api/terminology/search?text=${encodeURIComponent(text)}&lang=auto&limit=50`);
    const termData = await termRes.json();
    
    // 显示术语使用报告
    _paShowTermReport(termData.results || []);
    
    // 只注入实际匹配到的术语（不是全部 50 个）
    const matchedTerms = (termData.results || []).slice(0, 10); // 最多 10 个
    const termRefs = matchedTerms.map(r =>
      `${r.zh} → jp:${r.jp||''}, en:${r.en||''}, kr:${r.kr||''}, tw:${r.tw||''}, vn:${r.vn||''}, id:${r.id||''}, th:${r.th||''}`
    ).join('\n');

    const system = `你是一名资深游戏社区本地化专家，负责将中文游戏公告翻译为 7 种语言（日语、英语、韩语、繁体中文、越南语、印尼语、泰语），面向各地区的玩家群体。

## 核心要求

1. **翻译要地道自然**：不要逐字直译！像当地游戏运营写的一样。目标读者是游戏玩家，语言要活泼、有感染力、符合社交媒体风格
2. **术语必须精确**：游戏中的人名、地名、技能名、玩法名等专有名词，必须严格按照下方【术语对照表】翻译，不得自行编造
3. **完整保留原文结构**：
   - 原文有几个段落，翻译就有几个段落
   - 原文有换行符(\\n)，翻译也必须保留相同的换行
   - 原文有空行，翻译也保留空行
   - emoji 使用保持一致
4. **不要翻译游戏版本号和产品名**：如 V2.0、v16.0 等保持原样

## 输出格式

严格按以下 JSON 格式输出，不要加 markdown 代码块标记（不要加 \`\`\`json）：
{"jp":"日语翻译","en":"英语翻译","kr":"韩语翻译","tw":"繁中翻译","vn":"越南语翻译","id":"印尼语翻译","th":"泰语翻译"}

每个语言的值里必须用 \\n 保留原文的换行和段落。
${termRefs ? '\n## 术语对照表（必须严格使用以下翻译）\n' + termRefs : ''}`;

    const res = await fetch('/api/terminology/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, question: text, source: 'post-assistant' }),
    });
    if (res.status === 429) {
      const errData = await res.json();
      _paUpdateRemaining(0);
      throw new Error(errData.message || '今日翻译次数已用完');
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '翻译失败');

    // 更新剩余次数
    if (data.remaining !== null && data.remaining !== undefined) {
      _paUpdateRemaining(data.remaining);
    }

    let translations;
    try {
      const cleaned = data.data.content.replace(/```json?\s*/g, '').replace(/```\s*$/g, '').trim();
      translations = JSON.parse(cleaned);
    } catch {
      throw new Error('翻译结果格式异常，请重试');
    }

    // 保存缓存
    _paSaveCache(text, translations);
    window._paTranslations = translations;
    window._paTermCache = termData.results; // 保存术语缓存给校对用
    renderTranslations(translations, out);
    
    // 显示术语匹配提示
    const termCount = termData.results?.length || 0;
    const termHint = termCount > 0 ? ` 📚 已匹配 ${termCount} 个术语` : '';
    status.textContent = `✅ 翻译完成，结果已缓存（今日有效）${termHint}`;
    paSwitchTab('translate');
  } catch (err) {
    out.innerHTML = `<div class="error">❌ ${err.message}</div>`;
    status.textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function renderTranslations(t, container) {
  let html = '<div class="pa-trans-grid">';
  for (const [lang, label] of Object.entries(LANG_LABELS)) {
    html += `<div class="pa-trans-card">
      <div class="pa-trans-lang">${LANG_EMOJI[lang]} ${label}</div>
      <div class="pa-trans-text">${esc(t[lang] || '')}</div>
    </div>`;
  }
  html += '</div>';
  html += `<div class="pa-btn-row" style="margin-top:10px">
    <button class="btn-secondary" onclick="copyPaOutput()">📋 复制全部</button>
  </div>`;
  container.innerHTML = html;
}

// ===== 校对翻译（DeepSeek + 两阶段） =====
async function paProofread() {
  const text = document.getElementById('pa-editor').value.trim();
  const t = window._paTranslations;
  if (!t) return Toast.warning('请先点击“翻译成 7 语言”');
  
  // 检查是否有术语缓存
  if (!window._paTermCache || window._paTermCache.length === 0) {
    return Toast.warning('没有检测到术语数据，请先重新翻译');
  }
  
  const proofOut = document.getElementById('pa-proof-output');
  const btn = document.getElementById('pa-proof-btn');
  const status = document.getElementById('pa-status');
  btn.disabled = true;
  status.textContent = '⏳ 正在校对翻译...';

  try {
    // ⚠️ 不再调用 7 次 API，直接使用缓存的术语数据
    const matchedTerms = window._paTermCache.slice(0, 10); // 最多 10 个相关术语
    const allTermRefs = matchedTerms.map(r => `${r.zh} → jp:${r.jp||''}, en:${r.en||''}, kr:${r.kr||''}, tw:${r.tw||''}, vn:${r.vn||''}, id:${r.id||''}, th:${r.th||''}`).join('\n');

    const system = `你是游戏本地化质检专家。请检查以下 7 种语言的翻译质量。

## 已匹配的游戏术语（在原文中使用了这些）
${allTermRefs}

## 校对要求

请按以下格式逐项列出问题：

=== ISSUE START ===
类型: 术语不一致 | 语法错误 | 语气不当
严重度: 高 | 中 | 低
语言: jp/en/kr/tw/vn/id/th
原文: [原文片段]
建议: [修改建议]
原因: [详细解释]
=== ISSUE END ===

最后提供完整校对后的文本：
=== CORRECTED TEXT START ===
jp:[日语校对后文本]
en:[英语校对后文本]
kr:[韩语校对后文本]
tw:[繁中校对后文本]
vn:[越南语校对后文本]
id:[印尼语校对后文本]
th:[泰语校对后文本]
=== CORRECTED TEXT END ===`;

    const transText = Object.entries(LANG_LABELS).map(([k, v]) =>
      `${v}：${t[k] || '(无翻译)'}`
    ).join('\n');

    const res = await fetch('/api/terminology/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, question: `原文（中文）：${text}\n\n当前翻译：\n${transText}`, source: 'post-assistant' }),
    });
    if (res.status === 429) {
      const errData = await res.json();
      _paUpdateRemaining(0);
      throw new Error(errData.message || '今日翻译次数已用完');
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '校对失败');

    // 更新剩余次数
    if (data.remaining !== null && data.remaining !== undefined) {
      _paUpdateRemaining(data.remaining);
    }

    proofOut.innerHTML = `<div class="pa-proof-result"><h4>📋 校对结果</h4><pre class="pa-proof-text">${esc(data.data.content)}</pre></div>`;
    status.textContent = '✅ 校对完成';
    paSwitchTab('proofread');
  } catch (err) {
    proofOut.innerHTML = `<div class="error">❌ ${err.message}</div>`;
    status.textContent = '❌ ' + err.message;
    paSwitchTab('proofread');
  } finally {
    btn.disabled = false;
  }
}

function copyPaOutput() {
  const el = document.getElementById('pa-output');
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    Toast.success('已复制到剪贴板');
  }).catch(() => {
    Toast.error('复制失败');
  });
}

// ===== 剩余次数显示 =====
function _paUpdateRemaining(remaining) {
  const el = document.getElementById('pa-remaining-hint');
  if (!el) return;
  if (remaining === Infinity || remaining === null) {
    el.textContent = '🌟 超级管理员 · 不限次';
    el.style.color = 'var(--ink)';
  } else if (remaining > 5) {
    el.textContent = `今日剩余 ${remaining}/15 次`;
    el.style.color = '';
  } else if (remaining > 0) {
    el.textContent = `⚠️ 今日仅剩 ${remaining}/15 次`;
    el.style.color = 'var(--warn)';
  } else {
    el.textContent = '❗ 今日次数已用完（阿饱自费AI，勿浪费）';
    el.style.color = 'var(--err)';
  }
}

async function _paFetchRemaining() {
  try {
    const res = await fetch('/api/terminology/translation-remaining', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.ok) {
      _paUpdateRemaining(data.data.remaining);
    }
  } catch (_) {}
}

// ===== 初始化：自动恢复缓存 + 加载剩余次数 =====
document.addEventListener('DOMContentLoaded', () => {
  _paFetchRemaining();
  const latest = _paLoadLatestCache();
  if (latest) {
    document.getElementById('pa-editor').value = latest.text;
    window._paTranslations = latest.translations;
    renderTranslations(latest.translations, document.getElementById('pa-output'));
    document.getElementById('pa-status').textContent = '✅ 已自动恢复上次的翻译结果（今日有效）';
  }
});

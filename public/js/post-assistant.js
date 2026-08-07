/**
 * 贴文助手 — AI Studio + DeepSeek 双引擎版
 * 左栏：AI Studio 聊天窗（iframe 直嵌，内网环境）
 * 右栏：编辑器 + DeepSeek 翻译/校对
 * 特性：翻译结果可编辑、多语言选择、结构化校对
 */

const LANG_LABELS = { jp: '日语', en: '英语', kr: '韩语', tw: '繁中', vn: '越南语', id: '印尼语', th: '泰语' };
const LANG_EMOJI = { jp: '🇯🇵', en: '🇬🇧', kr: '🇰🇷', tw: '🇭🇰', vn: '🇻🇳', id: '🇮🇩', th: '🇹🇭' };

// ===== 工具函数 =====
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ===== 缓存机制（localStorage，1 自然天过期） =====
const PA_CACHE_PREFIX = 'pa_trans_';

function _paCacheKey(text, langs) {
  // 用文本哈希 + 语言组合做 key（更可靠）
  const langStr = langs ? langs.sort().join(',') : '';
  const textHash = text.substring(0, 50).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
  return PA_CACHE_PREFIX + textHash + '_' + langStr;
}

function _paSaveCache(text, translations, langs) {
  try {
    const cacheKey = _paCacheKey(text, langs);
    localStorage.setItem(cacheKey, JSON.stringify({
      text,
      translations,
      ts: Date.now(),
      date: new Date().toDateString()
    }));
  } catch (e) { /* localStorage 满了就忽略 */ }
}

function _paLoadCacheByKey(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    // 检查是否是同一天
    if (entry.date === new Date().toDateString()) {
      return entry.translations;
    }
    // 过期，删除
    localStorage.removeItem(key);
    return null;
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
  window._paCheckedLangs = null; // 清除选中的语言
  paSwitchTab('translate');
}

// ===== 渲染结构化校对结果 =====
function _paRenderStructuredProofResult(issues, correctedMap, container) {
  let html = `<div class="pa-proof-result">`;
  
  // 统计严重度
  const highCount = issues.filter(i => i.severity === '高').length;
  const mediumCount = issues.filter(i => i.severity === '中').length;
  const lowCount = issues.filter(i => i.severity === '低').length;
  
  html += `<h4>📋 校对概览：共发现 ${issues.length} 个问题（❌ 高 ${highCount} / ⚠️ 中 ${mediumCount} / ℹ️ 低 ${lowCount}）</h4>`;
  
  if (issues.length === 0) {
    html += '<p style="color:#22c55e">✅ 所有翻译质量良好，无需修改！</p>';
  } else {
    // 问题列表
    html += '<div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">';
    issues.forEach((issue, idx) => {
      const severityColor = issue.severity === '高' ? '#ef4444' : issue.severity === '中' ? '#f59e0b' : '#3b82f6';
      const severityIcon = issue.severity === '高' ? '❌' : issue.severity === '中' ? '⚠️' : 'ℹ️';
      
      html += `
        <div style="padding:12px;background:var(--panel-2);border-radius:8px;border-left:3px solid ${severityColor}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:13px;font-weight:600;color:var(--ink)">${issue.type}</span>
            <span style="font-size:12px;color:${severityColor};font-weight:600">${severityIcon} ${issue.severity}</span>
          </div>
          <div style="font-size:12px;color:var(--mut);margin-bottom:6px">
            🌐 ${LANG_LABELS[issue.language] || issue.language}<br>
            📖 原文：${esc(issue.original)}<br>
            💡 建议：${esc(issue.suggestion)}<br>
            📝 原因：${esc(issue.reason)}
          </div>
          <button onclick="applyCorrection('${issue.language}', \`${escapeBacktick(issue.suggestion)}\`)" 
                  style="font-size:12px;padding:4px 12px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer">
            ✅ 应用到翻译
          </button>
        </div>
      `;
    });
    html += '</div>';
  }
  
  // 校对后文本
  if (Object.keys(correctedMap).length > 0) {
    html += '<div style="margin-top:16px;padding:12px;background:var(--panel-2);border-radius:8px">';
    html += '<h4 style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:8px">✨ 校对后的完整文本</h4>';
    for (const [lang, text] of Object.entries(correctedMap)) {
      html += `<div style="margin-bottom:8px"><strong>${LANG_EMOJI[lang]} ${LANG_LABELS[lang]}</strong>:<br><pre style="font-size:12px;line-height:1.6;white-space:pre-wrap">${esc(text)}</pre></div>`;
    }
    html += `<button onclick="applyAllCorrections()" style="font-size:12px;padding:6px 16px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;margin-top:8px">
      🔄 全部应用
    </button></div>`;
  }
  
  html += '</div>';
  container.innerHTML = html;
}

// 应用单条校对建议
function applyCorrection(lang, text) {
  if (!window._paTranslations) return;
  window._paTranslations[lang] = text.trim();
  Toast.success(`${LANG_LABELS[lang]} 已更新`);
  
  // 重新渲染翻译卡片
  renderTranslations(window._paTranslations, document.getElementById('pa-output'), window._paCheckedLangs || Object.keys(LANG_LABELS));
}

// 应用全部校对建议
function applyAllCorrections() {
  if (!window._paTranslations) return;
  
  for (const [lang, text] of Object.entries(window._paTranslations)) {
    // 这里应该从 correctedMap 获取，但需要通过全局变量传递
    // 简化版：提示用户逐个应用
  }
  
  Toast.info('请逐个点击“应用”按钮，或手动编辑翻译结果');
}

// 反引号转义
function escapeBacktick(str) {
  return str.replace(/`/g, '\\`');
}

// ===== 保存翻译编辑 =====
function saveTranslationEdit(lang, text) {
  if (!window._paTranslations) return;
  
  window._paTranslations[lang] = text.trim();
  Toast.success(`${LANG_LABELS[lang]} 已保存`);
  
  // 更新缓存（重新生成 cache key）
  const currentText = document.getElementById('pa-editor').value.trim();
  const checkedLangs = window._paCheckedLangs || Object.keys(LANG_LABELS);
  const cacheKey = _paCacheKey(currentText, checkedLangs);
  localStorage.setItem(cacheKey, JSON.stringify({
    translations: window._paTranslations,
    timestamp: Date.now()
  }));
}

// 鼠标悬停时显示“保存”按钮
const originalRenderTranslations = renderTranslations;
renderTranslations = function(t, container, langs) {
  originalRenderTranslations(t, container, langs);
  
  // 监听输入框的 input 事件，自动高亮保存按钮
  container.querySelectorAll('[contenteditable]').forEach(el => {
    el.addEventListener('input', function() {
      const btn = this.parentElement.querySelector('.pa-save-btn');
      if (btn) btn.style.display = 'inline-block';
    });
  });
};

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
  
  // 显示前 10 个术语 + 添加按钮
  html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">';
  results.slice(0, 10).forEach(r => {
    const badgeColor = r.matchType === 'exact' ? '#10b981' : '#f59e0b';
    const typeLabel = r.matchType === 'exact' ? '✅' : '🔍';
    html += `<span style="display:inline-block;padding:2px 8px;background:var(--panel-3);border-radius:4px;font-size:11px;border-left:2px solid ${badgeColor};position:relative" onmouseover="showAddTermBtn(this, '${esc(r.matched)}')" onmouseout="hideAddTermBtn(this)">
      ${typeLabel} ${esc(r.matched)}
      <button class="add-term-btn" style="display:none;position:absolute;top:-8px;right:-8px;width:18px;height:18px;font-size:12px;line-height:1;background:white;border:1px solid var(--accent);border-radius:50%;padding:0;cursor:pointer;z-index:10" title="添加到术语库" onclick="event.stopPropagation(); addToTerminologyLibrary('${esc(r.matched)}')">+</button>
    </span>`;
  });
  if (results.length > 10) {
    html += `<span style="font-size:11px;color:var(--mut)">...还有 ${results.length - 10} 个</span>`;
  }
  html += '</div>';
  
  listEl.innerHTML = html;
  reportEl.style.display = 'block';
}

// 显示“添加到术语库”按钮
function showAddTermBtn(span, termText) {
  const btn = span.querySelector('.add-term-btn');
  if (btn) btn.style.display = 'block';
}

// 隐藏“添加到术语库”按钮
function hideAddTermBtn(span) {
  const btn = span.querySelector('.add-term-btn');
  if (btn) btn.style.display = 'none';
}

// 添加到术语库
async function addToTerminologyLibrary(termText) {
  if (!termText || !termText.length) return;
  
  try {
    const res = await fetch('/api/terminology/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cn: termText,
        jp: '',
        en: '',
        kr: '',
        tw: '',
        vn: '',
        id: '',
        th: ''
      })
    });
    
    const data = await res.json();
    if (data.ok) {
      Toast.success(`✅ 已将 "${termText}" 添加到术语库（待补充外语翻译）`);
      // 重新加载术语报告（刷新列表）
      setTimeout(() => {
        const editor = document.getElementById('pa-editor');
        if (editor && editor.value.trim()) {
          _paTranslate(); // 重新翻译以刷新术语报告
        }
      }, 500);
    } else {
      if (res.status === 401) {
        Toast.error('请先登录后再添加术语');
      } else {
        Toast.error(data.error || '添加失败');
      }
    }
  } catch (err) {
    console.error('[添加到术语库失败]', err);
    Toast.error('网络错误，请稍后重试');
  }
}

// ===== 翻译成选中语言（DeepSeek + 术语注入） =====
async function paTranslate() {
  const text = document.getElementById('pa-editor').value.trim();
  if (!text) return Toast.warning('请先在编辑区输入贴文内容');

  // 获取选中的语言
  const checkedLangs = Array.from(document.querySelectorAll('input[type="checkbox"][id^="pa-lang-"]:checked')).map(cb => cb.value);
  if (checkedLangs.length === 0) {
    return Toast.warning('请至少选择一种目标语言');
  }

  // 检查缓存（按文本 + 语言组合）
  const cacheKey = _paCacheKey(text, checkedLangs);
  const cached = _paLoadCacheByKey(cacheKey);
  if (cached) {
    window._paTranslations = cached;
    renderTranslations(cached, document.getElementById('pa-output'), checkedLangs);  // ← 传入选中的语言
    document.getElementById('pa-status').textContent = `✅ 已恢复缓存的翻译结果（${checkedLangs.join(', ')}）`;
    paSwitchTab('translate');
    return;
  }

  const out = document.getElementById('pa-output');
  const proofOut = document.getElementById('pa-proof-output');
  const btn = document.getElementById('pa-trans-btn');
  const status = document.getElementById('pa-status');
  btn.disabled = true;
  status.textContent = `⏳ 正在翻译为 ${checkedLangs.length} 种语言...`;

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

    const system = `你是一名资深游戏社区本地化专家，负责将中文游戏公告翻译为多语言，面向各地区的玩家群体。

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
{\"jp\":\"日语翻译\",\"en\":\"英语翻译\",\"kr\":\"韩语翻译\",\"tw\":\"繁中翻译\",\"vn\":\"越南语翻译\",\"id\":\"印尼语翻译\",\"th\":\"泰语翻译\"}

⚠️ **只输出选中的语言**，未选中的语言键值设为空字符串。例如选了日语和英语：
{\"jp\":\"翻译内容\",\"en\":\"translation content\",\"kr\":\"\",\"tw\":\"\",\"vn\":\"\",\"id\":\"\",\"th\":\"\"}

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

    // 保存缓存（只缓存选中的语言）
    _paSaveCache(text, translations, checkedLangs);
    window._paTranslations = translations;
    window._paTermCache = termData.results; // 保存术语缓存给校对用
    window._paCheckedLangs = checkedLangs; // 保存选中的语言
    renderTranslations(translations, out, checkedLangs);  // ← 传入选中的语言
    
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

function renderTranslations(t, container, langs) {
  const targetLangs = langs || Object.keys(LANG_LABELS);  // 默认全部 7 种
  let html = '<div class="pa-trans-grid">';
  for (const [lang] of Object.entries(LANG_LABELS)) {
    if (!targetLangs.includes(lang)) continue;  // 跳过未选中的语言
    html += `<div class="pa-trans-card">
      <div class="pa-trans-lang">${LANG_EMOJI[lang]} ${LANG_LABELS[lang]}</div>
      <div class="pa-trans-text" contenteditable="true" id="pa-trans-edit-${lang}" style="min-height:60px;padding:8px;border:1px dashed transparent;border-radius:4px;transition:border 0.2s" onfocus="this.style.border='1px dashed var(--accent)'" onblur="saveTranslationEdit('${lang}', this.textContent)">${esc(t[lang] || '')}</div>
      <button class="pa-save-btn" onclick="event.stopPropagation(); saveTranslationEdit('${lang}', document.getElementById('pa-trans-edit-${lang}').textContent)" style="display:none;position:absolute;top:8px;right:8px;font-size:12px;background:var(--accent);color:white;border:none;border-radius:4px;padding:4px 8px;cursor:pointer">💾 保存</button>
    </div>`;
  }
  html += '</div>';
  html += `<div class="pa-btn-row" style="margin-top:10px">
    <button class="btn-secondary" onclick="copyPaOutput()">📋 复制全部</button>
    <span style="font-size:11px;color:var(--mut);margin-left:8px">💡 点击翻译结果可直接编辑，修改后点击“保存”按钮确认</span>
  </div>`;
  container.innerHTML = html;
  
  // 监听输入框的 input 事件，自动高亮保存按钮
  setTimeout(() => {
    container.querySelectorAll('[contenteditable]').forEach(el => {
      el.addEventListener('input', function() {
        const btn = this.parentElement.querySelector('.pa-save-btn');
        if (btn) btn.style.display = 'inline-block';
      });
    });
  }, 0);
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

    // 🎯 解析结构化输出（ISSUE START/END + CORRECTED TEXT）
    const content = data.data.content;
    const issues = [];
    const correctedMap = {};
    
    // 提取 ISSUE
    const issueRegex = /=== ISSUE START ===\s*([\s\S]*?)=== ISSUE END ===/g;
    let match;
    while ((match = issueRegex.exec(content)) !== null) {
      const block = match[1].trim();
      const typeMatch = block.match(/类型:\s*([^|]+)/);
      const severityMatch = block.match(/严重度:\s*([^|\n]+)/);
      const langMatch = block.match(/语言:\s*(\w+)/);
      const originalMatch = block.match(/原文:\s*([^\n]+)/);
      const suggestionMatch = block.match(/建议:\s*([^\n]+)/);
      const reasonMatch = block.match(/原因:\s*([\s\S]+?)(?=\n\w+:|$)/);
      
      issues.push({
        type: typeMatch ? typeMatch[1].trim() : '未知',
        severity: severityMatch ? severityMatch[1].trim() : '中',
        language: langMatch ? langMatch[1] : '',
        original: originalMatch ? originalMatch[1].trim() : '',
        suggestion: suggestionMatch ? suggestionMatch[1].trim() : '',
        reason: reasonMatch ? reasonMatch[1].trim() : ''
      });
    }
    
    // 提取 CORRECTED TEXT
    const correctedMatch = content.match(/=== CORRECTED TEXT START ===\s*([\s\S]*?)=== CORRECTED TEXT END ===/);
    if (correctedMatch) {
      const lines = correctedMatch[1].trim().split('\n');
      for (const line of lines) {
        const kvMatch = line.match(/^(jp|en|kr|tw|vn|id|th):(.+)$/);
        if (kvMatch) {
          correctedMap[kvMatch[1]] = kvMatch[2].trim();
        }
      }
    }
    
    // 渲染结构化结果
    _paRenderStructuredProofResult(issues, correctedMap, proofOut);
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

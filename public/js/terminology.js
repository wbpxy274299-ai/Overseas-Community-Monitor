/**
 * 术语校对 - 完整前端
 * 4个Tab: 搜索 / 校对 / 批量校对 / 术语更新
 */

// ===== 语言配置 =====
const LANG_KEYS_MAP = { jp: 0, en: 1, kr: 2, tw: 3, vn: 4, id: 5, th: 6 };
const LANG_LABELS = { jp: '日语', en: '英语', kr: '韩语', tw: '繁中', vn: '越南语', id: '印尼语', th: '泰语' };
const LANG_EMOJI = { jp: '🇯🇵', en: '🇬🇧', kr: '🇰🇷', tw: '🇭🇰', vn: '🇻🇳', id: '🇮🇩', th: '🇹🇭' };
const LANG_COL_HEADERS = [
  { key: 'zh', label: '🇨🇳 中文' },
  { key: 'jp', label: '🇯🇵 日语' },
  { key: 'en', label: '🇬🇧 英语' },
  { key: 'kr', label: '🇰🇷 韩语' },
  { key: 'tw', label: '🇭🇰 繁中' },
  { key: 'vn', label: '🇻🇳 越南语' },
  { key: 'id', label: '🇮🇩 印尼语' },
  { key: 'th', label: '🇹🇭 泰语' },
];

// ===== 全局状态 =====
let currentBatchLang = 'jp';
let currentUpdateLang = 'jp';
let currentUpdateMode = 'batch';

// ===== 加载统计信息 =====
async function loadStats() {
  try {
    const res = await fetch('/api/terminology/stats');
    const d = await res.json();
    document.getElementById('statsBar').innerHTML =
      `📊 术语总数：<strong>${d.total.toLocaleString()}</strong> 条 · 版本：${d.version} · 支持 ${d.languages.length} 种语言`;
  } catch {
    document.getElementById('statsBar').textContent = '❌ 加载统计失败';
  }
}

// ===== Tab 切换 =====
function switchTermTab(tab) {
  document.querySelectorAll('.term-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.term-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.term-tab[onclick*="${tab}"]`).classList.add('active');
  document.getElementById(`panel-${tab}`).classList.add('active');
}

// ===== 工具函数 =====
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function escReg(s) { return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ======================================================================
//  TAB 1: 搜索术语
// ======================================================================
async function doTermSearch() {
  const q = document.getElementById('termSearchInput').value.trim();
  if (!q) return;
  const resultsEl = document.getElementById('searchResults');
  const countEl = document.getElementById('searchCount');
  resultsEl.innerHTML = '<div class="pa-status">⏳ 搜索中...</div>';
  countEl.textContent = '';

  try {
    const res = await fetch(`/api/terminology/search?q=${encodeURIComponent(q)}&limit=50`);
    const data = await res.json();
    renderSearchResults(data.results, q, countEl, resultsEl);
  } catch (err) {
    resultsEl.innerHTML = `<div class="error">搜索失败: ${err.message}</div>`;
  }
}

function renderSearchResults(results, query, countEl, container) {
  if (!results.length) {
    countEl.textContent = `搜索 "${query}" — 未找到`;
    container.innerHTML = '<div class="empty-state">😢 未找到匹配的术语，试试其他关键词？</div>';
    return;
  }
  countEl.textContent = `搜索 "${query}" — 找到 ${results.length} 条`;

  let html = '<table class="data-table"><thead><tr>';
  LANG_COL_HEADERS.forEach(c => html += `<th>${c.label}</th>`);
  html += '</tr></thead><tbody>';

  results.forEach(r => {
    html += '<tr>';
    LANG_COL_HEADERS.forEach(c => {
      const val = r[c.key] || '';
      const hl = query && val ? val.replace(new RegExp(`(${escReg(query)})`, 'gi'), '<mark>$1</mark>') : esc(val);
      html += `<td>${hl}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

// ======================================================================
//  TAB 2: 文案校对（自动检测语言，扫描全部 7 语言术语库）
// ======================================================================
async function doTermCheck() {
  const text = document.getElementById('checkInput').value.trim();
  if (!text) return;
  const resultEl = document.getElementById('checkResult');
  resultEl.innerHTML = '<div class="pa-status">⏳ 分析中...</div>';

  try {
    const res = await fetch(
      `/api/terminology/search?text=${encodeURIComponent(text)}&lang=auto&limit=100`
    );
    const data = await res.json();
    renderCheckResult(data.results || [], text, resultEl);
  } catch (err) {
    resultEl.innerHTML = `<div class="error">校对失败: ${err.message}</div>`;
  }
}

function renderCheckResult(matches, text, container) {
  if (!matches.length) {
    container.innerHTML = '<div class="empty-state">🔍 未在文本中发现游戏术语</div>';
    return;
  }
  let html = `<p class="found-count">发现 <strong>${matches.length}</strong> 个游戏术语</p>`;
  html += '<table class="data-table"><thead><tr><th>#</th>';
  LANG_COL_HEADERS.forEach(c => html += `<th>${c.label}</th>`);
  html += '</tr></thead><tbody>';

  matches.forEach((m, i) => {
    html += `<tr><td>${i + 1}</td>`;
    LANG_COL_HEADERS.forEach(c => html += `<td>${esc(m[c.key] || '')}</td>`);
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

// ======================================================================
//  TAB 3: 批量校对
// ======================================================================
function setBatchLang(btn) {
  btn.closest('.check-lang-bar').querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentBatchLang = btn.dataset.lang;
}

// 拖拽上传
function initBatchDragDrop() {
  const zone = document.getElementById('batchDropZone');
  if (!zone) return;
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleBatchFile(e.dataTransfer.files[0]);
  });
}

async function handleBatchFile(file) {
  if (!file) return;
  const status = document.getElementById('batchStatus');
  const result = document.getElementById('batchResult');
  status.textContent = `⏳ 读取文件: ${file.name}...`;
  result.innerHTML = '';

  try {
    const text = await file.text();
    let lines = [];

    if (file.name.endsWith('.json')) {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        lines = data.map(item => typeof item === 'string' ? item : (item.text || item.content || JSON.stringify(item)));
      }
    } else {
      // txt / csv: 每行一条
      lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    }

    if (!lines.length) return status.textContent = '⚠️ 文件中没有有效文案';
    if (lines.length > 500) lines = lines.slice(0, 500);

    status.textContent = `⏳ 正在校对 ${lines.length} 条文案（${LANG_LABELS[currentBatchLang]}）...`;

    const res = await fetch('/api/terminology/batch-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines, lang: currentBatchLang }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '校对失败');

    renderBatchResults(data.results, result);
    const hitLines = data.results.filter(r => r.hits > 0).length;
    status.textContent = `✅ 校对完成：${data.total} 条文案中 ${hitLines} 条包含游戏术语`;
  } catch (err) {
    status.textContent = '❌ ' + err.message;
  }
}

function renderBatchResults(results, container) {
  let html = '<table class="data-table"><thead><tr><th>#</th><th>文案</th><th>术语数</th><th>命中术语</th></tr></thead><tbody>';
  results.forEach(r => {
    const hitClass = r.hits > 0 ? 'batch-hit' : 'batch-no-hit';
    const terms = r.terms.map(t => `${t.zh}(${t.matched})`).join('、');
    html += `<tr class="${hitClass}"><td>${r.line}</td><td class="batch-text-cell">${esc(r.text)}</td><td>${r.hits}</td><td>${esc(terms)}</td></tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

// ======================================================================
//  TAB 5: 术语更新
// ======================================================================
function setUpdateMode(mode) {
  currentUpdateMode = mode;
  document.getElementById('updateBatchPanel').style.display = mode === 'batch' ? '' : 'none';
  document.getElementById('updateSinglePanel').style.display = mode === 'single' ? '' : 'none';
  document.getElementById('updateModeBatch').classList.toggle('active', mode === 'batch');
  document.getElementById('updateModeSingle').classList.toggle('active', mode === 'single');
}

function setUpdateLang(btn) {
  btn.closest('.check-lang-bar').querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentUpdateLang = btn.dataset.lang;
}

// 文件语言识别
const FILE_LANG_MAP = {
  'jp': 'jp', 'ja': 'jp', 'japanese': 'jp', '日语': 'jp',
  'en': 'en', 'english': 'en', '英语': 'en', '英文': 'en',
  'kr': 'kr', 'ko': 'kr', 'korean': 'kr', '韩语': 'kr',
  'tw': 'tw', 'hant': 'tw', '繁中': 'tw', '繁体': 'tw',
  'vn': 'vn', 'vi': 'vn', 'vietnamese': 'vn', '越南': 'vn',
  'id': 'id', 'indonesian': 'id', '印尼': 'id',
  'th': 'th', 'thai': 'th', '泰语': 'th',
};

function detectFileLang(filename) {
  const lower = filename.toLowerCase();
  for (const [keyword, lang] of Object.entries(FILE_LANG_MAP)) {
    if (lower.includes(keyword)) return lang;
  }
  return null;
}

// 读取 Excel 文件
function readExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        resolve(rows);
      } catch (err) {
        reject(new Error('Excel 解析失败: ' + file.name));
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败: ' + file.name));
    reader.readAsArrayBuffer(file);
  });
}

// 5a. 批量导入（多语言 Excel → 重建术语表）
async function handleUpdateBatch(files) {
  if (!files || !files.length) return;
  const status = document.getElementById('updateStatus');
  const stats = document.getElementById('updateStats');
  const list = document.getElementById('updateBatchList');
  status.textContent = `⏳ 正在解析 ${files.length} 个 Excel 文件...`;
  list.innerHTML = '';
  stats.textContent = '';

  try {
    // 识别语言 + 读取所有文件
    const langData = {}; // { jp: [{cn, value}], en: [...] }
    const fileInfo = [];

    for (const file of files) {
      const lang = detectFileLang(file.name);
      if (!lang) {
        fileInfo.push({ name: file.name, lang: '❓ 未识别', rows: 0 });
        continue;
      }
      const rows = await readExcel(file);
      const dataRows = rows.filter(r => r.length >= 2 && r[0]);
      if (!langData[lang]) langData[lang] = [];
      dataRows.forEach(r => {
        langData[lang].push({ cn: String(r[0]).trim(), value: String(r[1]).trim() });
      });
      fileInfo.push({ name: file.name, lang: LANG_LABELS[lang], rows: dataRows.length });
    }

    // 显示文件列表
    list.innerHTML = fileInfo.map(f =>
      `<div class="update-file-item"><span>${f.name}</span><span>${f.lang} · ${f.rows} 条</span></div>`
    ).join('');

    // 合并：以中文为key，构建 updates
    const cnMap = {}; // { cn: { jp, en, kr, ... } }
    for (const [lang, entries] of Object.entries(langData)) {
      for (const { cn, value } of entries) {
        if (!cn || cn === '中文' || cn === '术语') continue; // 跳过表头
        if (!cnMap[cn]) cnMap[cn] = { cn };
        cnMap[cn][lang] = value;
      }
    }

    const updates = Object.values(cnMap);
    if (!updates.length) return status.textContent = '⚠️ 没有有效术语数据';

    status.textContent = `⏳ 正在合并 ${updates.length} 条术语...`;
    const res = await fetch('/api/terminology/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '合并失败');

    status.textContent = `✅ 合并完成！新增 ${data.added} 条，更新 ${data.updated} 条，总计 ${data.total} 条`;
    stats.textContent = `涉及语言：${Object.keys(langData).map(k => LANG_LABELS[k]).join('、')}`;
    loadStats(); // 刷新统计
  } catch (err) {
    status.textContent = '❌ ' + err.message;
  }
}

// 5b. 单语言更新
async function handleUpdateSingle(file) {
  if (!file) return;
  const status = document.getElementById('updateStatus');
  const stats = document.getElementById('updateStats');
  status.textContent = `⏳ 正在解析: ${file.name}...`;
  stats.textContent = '';

  try {
    const rows = await readExcel(file);
    const dataRows = rows.filter(r => r.length >= 2 && r[0]);
    if (!dataRows.length) return status.textContent = '⚠️ 文件中没有有效数据';

    const updates = dataRows.map(r => ({
      cn: String(r[0]).trim(),
      [currentUpdateLang]: String(r[1]).trim(),
    })).filter(u => u.cn && u.cn !== '中文' && u.cn !== '术语');

    if (!updates.length) return status.textContent = '⚠️ 没有有效术语';

    status.textContent = `⏳ 正在合并 ${updates.length} 条术语（${LANG_LABELS[currentUpdateLang]}）...`;
    const res = await fetch('/api/terminology/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '合并失败');

    status.textContent = `✅ 合并完成！新增 ${data.added} 条，更新 ${data.updated} 条，总计 ${data.total} 条`;
    stats.textContent = `语言：${LANG_LABELS[currentUpdateLang]} · 文件：${file.name}`;
    loadStats();
  } catch (err) {
    status.textContent = '❌ ' + err.message;
  }
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  initBatchDragDrop();

  document.getElementById('termSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doTermSearch();
  });

  // 单语言更新拖拽
  const singleInput = document.getElementById('updateSingleInput');
  if (singleInput) {
    const zone = singleInput.closest('.batch-upload-zone');
    if (zone) {
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) handleUpdateSingle(e.dataTransfer.files[0]);
      });
    }
  }

  // 批量更新拖拽
  const batchInput = document.getElementById('updateBatchInput');
  if (batchInput) {
    const zone = batchInput.closest('.batch-upload-zone');
    if (zone) {
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) handleUpdateBatch(e.dataTransfer.files);
      });
    }
  }
});

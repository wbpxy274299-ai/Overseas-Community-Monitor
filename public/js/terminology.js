/**
 * 术语校对 - 轻量版前端
 * 不调 43MB 术语库，改为请求后端 API 搜索（后端已内存加载10万条）
 */

const LANG_KEYS = ['zh', 'ja', 'en', 'ko', 'zh-tw', 'vi', 'id', 'th'];
const LANG_NAMES = { 'zh': '中文', 'ja': '日语', 'en': '英语', 'ko': '韩语', 'zh-tw': '繁中', 'vi': '越南语', 'id': '印尼语', 'th': '泰语' };
const LANG_EMOJI = { 'zh': '🇨🇳', 'ja': '🇯🇵', 'en': '🇬🇧', 'ko': '🇰🇷', 'zh-tw': '🇭🇰', 'vi': '🇻🇳', 'id': '🇮🇩', 'th': '🇹🇭' };

// 加载统计信息
async function loadStats() {
  try {
    const res = await fetch('/api/terminology/stats');
    const d = await res.json();
    document.getElementById('statsBar').innerHTML = `📊 术语总数：<strong>${d.total.toLocaleString()}</strong> 条 · 版本：${d.version} · 支持 ${LANG_KEYS.length} 种语言`;
  } catch {
    document.getElementById('statsBar').textContent = '❌ 加载统计失败';
  }
}

// Tab 切换
function switchTermTab(tab) {
  document.querySelectorAll('.term-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.term-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.term-tab[onclick*="${tab}"]`).classList.add('active');
  document.getElementById(`panel-${tab}`).classList.add('active');
}

// ===== 搜索术语（调后端 API） =====
async function doTermSearch() {
  const q = document.getElementById('termSearchInput').value.trim();
  if (!q) return;

  const resultsEl = document.getElementById('searchResults');
  const countEl = document.getElementById('searchCount');
  resultsEl.innerHTML = '⏳ 搜索中...';
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
    container.innerHTML = `<div class="empty-state">😢 未找到匹配的术语，试试其他关键词？</div>`;
    return;
  }

  countEl.textContent = `搜索 "${query}" — 找到 ${results.length} 条`;

  let html = '<table class="data-table"><thead><tr>';
  LANG_KEYS.forEach(k => html += `<th>${LANG_EMOJI[k]} ${LANG_NAMES[k]}</th>`);
  html += '<th>📁 分类</th></tr></thead><tbody>';

  results.forEach(r => {
    html += '<tr>';
    LANG_KEYS.forEach(k => {
      const val = r[k] || '';
      const highlighted = query && val ? val.replace(new RegExp(`(${escReg(query)})`, 'gi'), '<mark>$1</mark>') : esc(val);
      html += `<td>${highlighted}</td>`;
    });
    const cat = [r.category, r.subCategory1, r.subCategory2].filter(Boolean).join(' > ');
    html += `<td class="cat-cell">${esc(cat)}</td></tr>`;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

// ===== 文案校对 =====
async function doTermCheck() {
  const text = document.getElementById('checkInput').value.trim();
  if (!text) return;

  const resultEl = document.getElementById('checkResult');
  resultEl.innerHTML = '⏳ 分析中...';

  try {
    const res = await fetch(`/api/terminology/search?q=${encodeURIComponent('__extract__')}&text=${encodeURIComponent(text)}`);
    const data = await res.json();
    renderCheckResult(data.results || data.matches || [], text, resultEl);
  } catch (err) {
    resultEl.innerHTML = `<div class="error">校对失败: ${err.message}</div>`;
  }
}

function renderCheckResult(matches, text, container) {
  if (!matches.length) {
    container.innerHTML = `<div class="empty-state">🔍 未在文本中发现游戏术语</div>`;
    return;
  }

  let html = `<p class="found-count">发现 <strong>${matches.length}</strong> 个游戏术语</p>`;
  html += '<table class="data-table"><thead><tr><th>#</th><th>🇯🇵 日语原文</th><th>🇨🇳 中文</th><th>🇭🇰 繁中</th><th>🇬🇧 英语</th><th>🇰🇷 韩语</th></tr></thead><tbody>';

  matches.forEach((m, i) => {
    html += `<tr><td>${i + 1}</td><td>${esc(m.ja || '')}</td><td>${esc(m.zh || '')}</td><td>${esc(m['zh-tw'] || '')}</td><td>${esc(m.en || '')}</td><td>${esc(m.ko || '')}</td></tr>`;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

// ===== 工具函数 =====
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  document.getElementById('termSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doTermSearch();
  });
});

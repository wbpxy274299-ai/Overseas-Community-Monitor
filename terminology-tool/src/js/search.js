/* ========================================
   游戏术语校对工具 - 搜索模块
   ======================================== */

/**
 * 执行搜索
 */
function doSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const results = [];

  // 精确匹配
  if (ALL_INDEX[query] !== undefined) {
    for (const i of ALL_INDEX[query]) results.push(i);
  }

  // 模糊匹配（中文包含关键词）
  for (let i = 0; i < TERMS.length && results.length < 200; i++) {
    if (results.includes(i)) continue;
    const cn = TERMS[i][0];
    if (cn && (cn.includes(query) || cn.toLowerCase().includes(query.toLowerCase()))) {
      results.push(i);
    }
  }

  renderResults(results, query);
}

/**
 * 渲染搜索结果
 */
function renderResults(indices, query) {
  const container = document.getElementById('search-results');
  document.getElementById('search-count').textContent = '找到 ' + indices.length + ' 条结果';

  if (indices.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#999">未找到匹配的术语</div>';
    return;
  }

  let html = '';
  for (const idx of indices) {
    const t = TERMS[idx];
    const cn = t[0];
    const hcn = highlight(cn, query);

    let transHtml = '';
    for (const lk of LANG_KEYS) {
      const text = t[LANG_KEYS.indexOf(lk) + 1];
      if (text) {
        transHtml += '<div class="trans"><span class="label">'
          + LANG_EMOJI[lk] + ' ' + LANG_NAMES[lk]
          + '</span>' + esc(text) + '</div>';
      }
    }

    html += '<div class="result-item">'
      + '<div class="cn">' + hcn + '</div>'
      + '<div class="translations">' + transHtml + '</div>'
      + '<div class="meta">'
      + (t[8] ? '<span class="cat">' + esc(t[8]) + '</span>' : '')
      + (t[9] ? esc(t[9]) : '')
      + (t[10] ? ' \u00B7 ' + esc(t[10]) : '')
      + '</div></div>';
  }

  container.innerHTML = html;
}

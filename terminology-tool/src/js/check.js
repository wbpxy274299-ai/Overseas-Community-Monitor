/* ========================================
   游戏术语校对工具 - 校对模块（单条 + 批量）
   ======================================== */

/**
 * 单条校对：匹配输入文本中的术语
 */
function doCheck() {
  const text = document.getElementById('check-input').value.trim();
  if (!text) return;

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const matches = [];
  const seen = new Set();

  // 按术语长度从长到短排序，优先匹配长术语
  const sortedTerms = Object.entries(ALL_INDEX)
    .map(([term, indices]) => ({ term, indices }))
    .sort((a, b) => b.term.length - a.term.length);

  for (const { term, indices } of sortedTerms) {
    for (const idx of indices) {
      if (seen.has(idx)) continue;
      for (const line of lines) {
        if (line.length < 2) continue;
        const nl = normalize(line);
        if (nl.includes(term)) {
          seen.add(idx);
          matches.push({ matchedText: term, fullTerm: term, termIndex: idx });
          break;
        }
        if (term.includes(nl) && nl.length >= 2) {
          seen.add(idx);
          matches.push({ matchedText: nl, fullTerm: term, termIndex: idx });
          break;
        }
      }
      if (seen.has(idx)) break;
    }
  }

  if (matches.length >= 200) matches.length = 200;
  renderCheckResult(text, matches);
}

/**
 * 渲染单条校对结果
 */
function renderCheckResult(text, matches) {
  let html = '<div style="margin-bottom:12px;font-weight:600">校对结果（发现 '
    + matches.length + ' 个术语）</div>';

  // 高亮原文中的术语
  let highlighted = esc(text);
  const sorted = [...matches].sort((a, b) => b.matchedText.length - a.matchedText.length);
  for (const m of sorted) {
    const s = esc(m.matchedText);
    highlighted = highlighted.replace(
      new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      '<span class="term-match" title="' + esc(m.fullTerm) + '">' + s + '</span>'
    );
  }
  html += '<div style="line-height:2;margin-bottom:16px;white-space:pre-wrap">'
    + highlighted + '</div>';

  // 术语对照表
  if (matches.length > 0) {
    let header = '<tr><th>原文</th><th>中文</th><th>日语</th><th>英语</th><th>韩语</th>'
      + '<th>繁中</th><th>越南语</th><th>印尼语</th><th>泰语</th></tr>';
    let rows = '';
    for (const m of matches) {
      const t = TERMS[m.termIndex];
      rows += '<tr>'
        + '<td>' + esc(m.matchedText) + '</td>'
        + '<td class="ok">' + esc(t[0]) + '</td>'
        + '<td>' + esc(t[1] || '-') + '</td>'
        + '<td>' + esc(t[2] || '-') + '</td>'
        + '<td>' + esc(t[3] || '-') + '</td>'
        + '<td>' + esc(t[4] || '-') + '</td>'
        + '<td>' + esc(t[5] || '-') + '</td>'
        + '<td>' + esc(t[6] || '-') + '</td>'
        + '<td>' + esc(t[7] || '-') + '</td>'
        + '</tr>';
    }
    html += '<div class="check-detail"><table>' + header + rows + '</table></div>';
  } else {
    html += '<div style="color:#999;text-align:center;padding:20px">未发现术语表中的术语</div>';
  }

  document.getElementById('check-result').innerHTML = html;
}

/**
 * 批量校对：上传文件后逐行匹配
 */
function handleBatchCheck(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (ev) {
    const content = ev.target.result;
    let lines = [];

    if (file.name.endsWith('.json')) {
      try {
        lines = JSON.parse(content);
        if (!Array.isArray(lines)) lines = [lines];
      } catch {
        lines = content.split('\n');
      }
    } else {
      lines = content.split('\n');
    }

    lines = lines.map(l => l.trim()).filter(l => l.length > 0);
    let totalTerms = 0;

    let detailHtml = '<div class="check-detail"><table>'
      + '<tr><th>#</th><th>原文</th><th>术语匹配</th><th>状态</th></tr>';

    lines.forEach((line, i) => {
      const lineMatches = [];
      const nl = normalize(line);
      for (const [term, indices] of Object.entries(ALL_INDEX)) {
        if (nl.includes(term)) {
          for (const idx of indices) {
            lineMatches.push(TERMS[idx][0]);
            totalTerms++;
          }
        }
      }

      const status = lineMatches.length > 0
        ? '<span style="color:#28a745">\u2705 ' + lineMatches.length + ' 个术语</span>'
        : '<span style="color:#999">无术语</span>';

      detailHtml += '<tr>'
        + '<td>' + (i + 1) + '</td>'
        + '<td>' + esc(line.substring(0, 80)) + (line.length > 80 ? '...' : '') + '</td>'
        + '<td>' + lineMatches.map(m => esc(m)).join(', ') + '</td>'
        + '<td>' + status + '</td>'
        + '</tr>';
    });

    detailHtml += '</table></div>';

    document.getElementById('batch-result').innerHTML =
      '<div style="margin:16px 0;font-weight:600">批量校对完成 \u2014 共 '
      + lines.length + ' 条文案，发现 ' + totalTerms + ' 个术语</div>'
      + detailHtml;
  };
  reader.readAsText(file);
}

/**
 * 玩家洞察 — 页面逻辑
 * 调用后端 AI 分析接口，渲染 Markdown 报告
 */

// 计算上周五~本周四
function calcPeriod() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 5=Fri
  const lastFriday = new Date(now);
  // 如果今天是周五(5)、周六(6)，上周五就是本周五
  // 否则往前找上一个周五
  if (day >= 5) {
    lastFriday.setDate(now.getDate() - (day - 5));
  } else {
    lastFriday.setDate(now.getDate() - (day + 2));
  }
  lastFriday.setHours(0, 0, 0, 0);
  const thisThursday = new Date(lastFriday);
  thisThursday.setDate(lastFriday.getDate() + 6);
  thisThursday.setHours(23, 59, 59, 999);

  const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  return { start: fmt(lastFriday), end: fmt(thisThursday), label: fmt(lastFriday) + ' ~ ' + fmt(thisThursday) };
}

// 简单 Markdown 渲染
function renderMarkdown(md) {
  // 先处理块引用（blockquote）
  const lines = md.split('\n');
  let html = '';
  let inBlockquote = false;
  let blockquoteContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('> ')) {
      if (!inBlockquote) {
        inBlockquote = true;
        blockquoteContent = '';
      }
      blockquoteContent += line.substring(2) + '<br>';
    } else {
      if (inBlockquote) {
        html += '<blockquote class="player-quote">' + processInline(blockquoteContent.replace(/<br>$/, '')) + '</blockquote>';
        inBlockquote = false;
        blockquoteContent = '';
      }
      html += processLine(line) + '\n';
    }
  }
  if (inBlockquote) {
    html += '<blockquote class="player-quote">' + processInline(blockquoteContent.replace(/<br>$/, '')) + '</blockquote>';
  }

  return '<div class="report-content">' + html + '</div>';
}

function processInline(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function processLine(line) {
  // 标题
  if (/^### (.+)/.test(line)) return '<h3>' + processInline(line.replace(/^### /, '')) + '</h3>';
  if (/^## (.+)/.test(line)) return '<h2 class="report-h2">' + processInline(line.replace(/^## /, '')) + '</h2>';
  if (/^# (.+)/.test(line)) return '<h1 class="report-h1">' + processInline(line.replace(/^# /, '')) + '</h1>';
  // 分割线
  if (/^---+$/.test(line)) return '<hr>';
  // 列表
  if (/^[\-\*] (.+)/.test(line)) return '<li>' + processInline(line.replace(/^[\-\*] /, '')) + '</li>';
  if (/^\d+\. (.+)/.test(line)) return '<li>' + processInline(line.replace(/^\d+\. /, '')) + '</li>';
  // 空行
  if (!line.trim()) return '<br>';
  // 普通段落
  return '<p>' + processInline(line) + '</p>';
}

// 初始化
function initPage() {
  const period = calcPeriod();
  document.getElementById('periodLabel').textContent = '分析周期 · ' + period.label;
  const emptyLabel = document.getElementById('emptyPeriodLabel');
  if (emptyLabel) emptyLabel.textContent = 'Current Insight · 分析周期 ' + period.label;
  loadHistory();
}

// 加载历史报告列表
async function loadHistory() {
  const container = document.getElementById('historyList');
  try {
    const res = await fetch('/api/admin/insights/list', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.ok && data.data.length > 0) {
      renderHistoryList(data.data);
    } else {
      container.innerHTML = '<div class="history-empty">暂无历史报告</div>';
    }
  } catch (e) {
    container.innerHTML = '<div class="history-empty">加载失败</div>';
  }
}

function renderHistoryList(reports) {
  const container = document.getElementById('historyList');
  // 更新历史报告计数
  const countEl = document.getElementById('historyCount');
  if (countEl) countEl.textContent = '历史报告 · ' + reports.length + ' 份';
  const titleEl = document.getElementById('historyTitle');
  if (titleEl) titleEl.textContent = '历史报告存档 · 共 ' + reports.length + ' 份';

  container.innerHTML = reports.map(r => `
    <div class="rep-card" style="margin-bottom:12px" onclick="viewReport(${r.id})">
      <div class="rh">
        <span class="rt">${escapeHtml(r.period)}</span>
        <span class="chip" style="padding:2px 8px;font-size:10px">${r.total_records} 条数据 · JP ${r.twitter_count} · TW ${r.discord_count}</span>
      </div>
      <div class="rm">📅 生成于 ${formatDate(r.created_at)}</div>
      <div style="margin-top:12px"><a class="btn-op" onclick="event.stopPropagation(); viewReport(${r.id})">查看</a><a class="btn-op danger" onclick="event.stopPropagation(); deleteReport(${r.id})">删除</a></div>
    </div>
  `).join('');
}

// 查看历史报告
async function viewReport(id) {
  const reportArea = document.getElementById('reportArea');
  reportArea.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>加载报告中...</p></div>';
  // 滚动到报告区域
  reportArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const res = await fetch('/api/admin/insights/' + id, { credentials: 'same-origin' });
    const data = await res.json();
    if (data.ok) {
      const r = data.data;
      document.getElementById('statsBar').style.display = 'flex';
      document.getElementById('statTotal').textContent = r.total_records;
      document.getElementById('statTwitter').textContent = r.twitter_count;
      document.getElementById('statDiscord').textContent = r.discord_count;
      document.getElementById('statPeriod').textContent = r.period;
      document.getElementById('periodLabel').textContent = '分析周期 · ' + r.period;
      const emptyLabel = document.getElementById('emptyPeriodLabel');
      if (emptyLabel) emptyLabel.textContent = 'Current Insight · 分析周期 ' + r.period;
      reportArea.innerHTML = renderMarkdown(r.content);
    } else {
      reportArea.innerHTML = '<div class="error-state"><p>' + (data.error || '加载失败') + '</p></div>';
    }
  } catch (e) {
    reportArea.innerHTML = '<div class="error-state"><p>网络错误</p></div>';
  }
}

// 删除报告
async function deleteReport(id) {
  if (!confirm('确定要删除这份报告吗？')) return;
  try {
    const res = await fetch('/api/admin/insights/' + id, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) {
      Toast.success('报告已删除');
      loadHistory();
    } else {
      Toast.error(data.error);
    }
  } catch (e) {
    Toast.error('删除失败');
  }
}

// 生成报告
async function generateInsights() {
  const btn = document.getElementById('btnGenerate');
  btn.disabled = true;
  btn.textContent = '⏳ AI 正在分析中...（约30~60秒）';

  const reportArea = document.getElementById('reportArea');
  reportArea.innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <p>AI 正在分析玩家发言数据，请稍候...</p>
      <small>通常需要 30~60 秒，取决于数据量</small>
    </div>`;

  try {
    const res = await fetch('/api/admin/insights/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    });
    const data = await res.json();

    if (data.ok) {
      // 显示统计
      document.getElementById('statsBar').style.display = 'flex';
      document.getElementById('statTotal').textContent = data.totalRecords;
      document.getElementById('statTwitter').textContent = data.twitterCount;
      document.getElementById('statDiscord').textContent = data.discordCount;
      document.getElementById('statPeriod').textContent = data.period;
      document.getElementById('periodLabel').textContent = '分析周期 · ' + data.period;
      const emptyLabel = document.getElementById('emptyPeriodLabel');
      if (emptyLabel) emptyLabel.textContent = 'Current Insight · 分析周期 ' + data.period;

      // 渲染报告
      reportArea.innerHTML = renderMarkdown(data.report);
      Toast.success('报告生成成功！');
      // 刷新历史列表
      loadHistory();
    } else {
      reportArea.innerHTML = `<div class="error-state">
        <div class="error-icon">⚠️</div>
        <h3>分析失败</h3>
        <p>${data.message || data.error || '请稍后重试'}</p>
      </div>`;
      Toast.error(data.message || '分析失败');
    }
  } catch (e) {
    reportArea.innerHTML = `<div class="error-state">
      <div class="error-icon">❌</div>
      <h3>网络错误</h3>
      <p>${e.message}</p>
    </div>`;
    Toast.error('网络错误: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = '🤖 生成洞察报告';
}

window.addEventListener('DOMContentLoaded', () => {
  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (!user) { window.location.href = '/login'; return; }
  initPage();
});

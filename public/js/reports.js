/**
 * 周报管理 — 页面逻辑
 */
const API_BASE = '/api/weekly-report';
const SENTIMENT_API = '/api/sentiment';

// 加载报告列表
async function loadReports() {
  try {
    const response = await fetch(`${SENTIMENT_API}/reports`);
    const data = await response.json();
    if (data.ok) {
      renderReportList(data.data);
      document.getElementById('reportCount').textContent = data.data.length;
    } else {
      Toast.error('加载失败: ' + data.error);
    }
  } catch (error) {
    console.error('加载报告列表失败:', error);
    Toast.error('网络错误');
  }
}

// 渲染报告列表
function renderReportList(reports) {
  const container = document.getElementById('reportList');
  if (!reports || reports.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size: 48px; margin-bottom: 20px;">📄</div>
        <div>暂无报告</div>
        <div style="font-size: 13px; margin-top: 10px;">点击"生成新周报"按钮创建第一份报告</div>
      </div>`;
    return;
  }
  let html = '';
  for (const report of reports) {
    const riskClass = report.risk_level === 'high' ? 'badge-high' :
                     report.risk_level === 'medium' ? 'badge-medium' : 'badge-low';
    const riskLabel = report.risk_level === 'high' ? '🔴 高风险' :
                     report.risk_level === 'medium' ? '🟡 中风险' : '🟢 低风险';
    const summaryText = report.summary || '无摘要';
    const previewText = summaryText.length > 80 ? summaryText.substring(0, 80) + '...' : summaryText;
    html += `
      <div class="report-card" onclick="viewReport(${report.id})">
        <div class="report-header">
          <div class="report-title">${escapeHtml(report.title)}</div>
          <span class="badge ${riskClass}">${riskLabel}</span>
        </div>
        <div class="report-meta">
          <span>📅 ${formatDate(report.created_at)}</span>
          <span>📊 ${report.twitter_count || 0} Twitter / ${report.discord_count || 0} Discord</span>
        </div>
        <div class="report-summary">
          <strong style="color: #667eea;">💡 核心观点：</strong><br>
          ${escapeHtml(previewText)}
        </div>
        <div class="report-actions">
          <button class="btn btn-secondary" onclick="event.stopPropagation(); downloadReport(${report.id})">📥 下载</button>
        </div>
      </div>`;
  }
  container.innerHTML = html;
}

// 生成新报告
async function generateReport() {
  const btn = document.getElementById('generateReportBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 生成中...';
  try {
    const response = await fetch(`${API_BASE}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await response.json();
    if (data.ok) {
      Toast.success('✅ 报告生成成功');
      loadReports();
    } else {
      Toast.error('❌ 生成失败: ' + (data.error || '未知错误'));
    }
  } catch (error) {
    console.error('生成报告失败:', error);
    Toast.error('❌ 网络错误');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 生成新周报';
  }
}

// 检查数据状态
async function checkData() {
  try {
    Toast.info('🔍 检查中...');
    const response = await fetch(`${API_BASE}/check-data`);
    const result = await response.json();
    if (result.ok) {
      const data = result.data;
      let msg = '📊 数据状态\n\n';
      if (data.actualRange) {
        msg += `实际时间: ${data.actualRange.start.substring(0, 10)} ~ ${data.actualRange.end.substring(0, 10)}\n`;
      } else {
        msg += `时间范围: ${data.dateRange.start.substring(0, 10)} ~ ${data.dateRange.end.substring(0, 10)}\n`;
      }
      msg += `总记录数: ${data.total}\nTwitter: ${data.twitter} 条\nDiscord: ${data.discord} 条`;
      alert(msg);
    } else {
      alert('❌ 检查失败: ' + (result.error || '未知错误'));
    }
  } catch (error) {
    console.error('❌ 检查数据失败:', error);
    Toast.error('❌ 检查失败: ' + error.message);
  }
}

// 查看报告详情
async function viewReport(id) {
  try {
    const response = await fetch(`${SENTIMENT_API}/report/${id}`);
    const data = await response.json();
    if (data.ok) {
      document.getElementById('modalTitle').textContent = data.data.title;
      document.getElementById('modalContent').innerHTML = renderMarkdown(data.data.content);
      document.getElementById('reportModal').classList.add('active');
    } else {
      Toast.error('加载失败: ' + data.error);
    }
  } catch (error) {
    console.error('加载报告失败:', error);
    Toast.error('网络错误');
  }
}

// 下载报告
async function downloadReport(id) {
  try {
    const response = await fetch(`${SENTIMENT_API}/report/${id}/download`);
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yuqing_report_${id}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    Toast.success('✅ 下载成功');
  } catch (error) {
    console.error('下载失败:', error);
    Toast.error('❌ 下载失败');
  }
}

// 关闭弹窗
function closeModal() {
  document.getElementById('reportModal').classList.remove('active');
}

// Markdown 渲染器
function renderMarkdown(text) {
  if (!text) return '';
  let escaped = escapeHtml(text);
  const lines = escaped.split('\n');
  let html = '';
  let inTable = false, inBlockquote = false, inList = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^-{3,}$/.test(trimmed) || /^---$/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<hr>'; continue;
    }
    if (/^### .+/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h3>' + applyInline(trimmed.slice(4)) + '</h3>'; continue;
    }
    if (/^## .+/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h2>' + applyInline(trimmed.slice(3)) + '</h2>'; continue;
    }
    if (/^# .+/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h1>' + applyInline(trimmed.slice(2)) + '</h1>'; continue;
    }
    if (/^\|.+\|$/.test(trimmed)) {
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) continue;
      if (!inTable) { html += '<table>'; inTable = true; }
      const isFirstRow = !inTable || html.endsWith('<table>');
      const tag = isFirstRow ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${applyInline(c)}</${tag}>`).join('') + '</tr>';
      continue;
    } else if (inTable) { html += '</table>'; inTable = false; }
    if (/^&gt;\s?/.test(trimmed)) {
      if (inList) { html += '</ul>'; inList = false; }
      if (!inBlockquote) { html += '<blockquote>'; inBlockquote = true; }
      else { html += '<br>'; }
      html += applyInline(trimmed.replace(/^&gt;\s?/, '')); continue;
    } else if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
    if (/^- .+/.test(trimmed)) {
      if (inList === false) { html += '<ul>'; inList = true; }
      html += '<li>' + applyInline(trimmed.slice(2)) + '</li>'; continue;
    } else if (inList) { html += '</ul>'; inList = false; }
    if (trimmed === '') {
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      continue;
    }
    html += '<p>' + applyInline(trimmed) + '</p>';
  }
  if (inTable) html += '</table>';
  if (inBlockquote) html += '</blockquote>';
  if (inList) html += '</ul>';
  return html;
}

function applyInline(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// 点击弹窗外部关闭
document.getElementById('reportModal').addEventListener('click', (e) => {
  if (e.target.id === 'reportModal') closeModal();
});

window.addEventListener('DOMContentLoaded', () => { loadReports(); });

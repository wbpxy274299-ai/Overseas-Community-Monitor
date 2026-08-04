/**
 * 周报管理 — 页面逻辑
 */
const API_BASE = '/api/weekly-report';
const SENTIMENT_API = '/api/sentiment';

let currentReportId = null;

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
      <div class="empty-state" style="grid-column:1/-1">
        <div style="font-size: 48px; margin-bottom: 20px;">📄</div>
        <div>暂无报告</div>
        <div style="font-size: 13px; margin-top: 10px;">点击“生成新周报”按钮创建第一份报告</div>
      </div>`;
    document.getElementById('currentReportPanel').style.display = 'none';
    return;
  }

  // 最新报告填充当前周报面板
  const latest = reports[0];
  currentReportId = latest.id;
  const panel = document.getElementById('currentReportPanel');
  panel.style.display = '';
  
  const riskClass = latest.risk_level === 'high' ? '#E88B81' :
                   latest.risk_level === 'medium' ? 'var(--warn)' : '#7CC79A';
  const riskLabel = latest.risk_level === 'high' ? '高' :
                   latest.risk_level === 'medium' ? '中' : '低';
  
  // 标题
  const titleDate = latest.title ? latest.title.match(/\d{4}-\d{2}-\d{2}/)?.[0] : '';
  document.getElementById('currentReportTitle').innerHTML = `Current Report<br>当前周报${titleDate ? ' · ' + titleDate : ''}`;
  
  // 元数据
  document.getElementById('currentReportMeta').innerHTML = `生成于 ${formatDate(latest.created_at)}<br>数据来源：Twitter（Yahoo实时搜索）+ Discord（繁中服）`;
  
  // 统计卡片
  const tw = latest.twitter_count || 0;
  const dc = latest.discord_count || 0;
  const total = tw + dc;
  document.getElementById('currentReportStats').innerHTML = `
    <div class="lstat"><div class="n">${total}</div><div class="t">本周共收集 · 条</div></div>
    <div class="lstat" style="border-left:3px solid #4A9EDA"><div class="n">${tw}</div><div class="t">Twitter</div></div>
    <div class="lstat" style="border-left:3px solid #6A5ACD"><div class="n">${dc}</div><div class="t">Discord</div></div>
    <div class="lstat" style="border-left:3px solid ${riskClass}"><div class="n" style="color:${riskClass}">${riskLabel}</div><div class="t">风险等级</div></div>
  `;
  
  // 加载最新报告内容，按章节拆分，只展示总览+发言概况+AI分析
  const contentEl = document.getElementById('currentReportContent');
  contentEl.innerHTML = '<div style="color:var(--cut-mut);font-size:13px"> 加载报告内容...</div>';
  fetch(`${SENTIMENT_API}/report/${latest.id}`)
    .then(r => r.json())
    .then(data => {
      if (data.ok && data.data.content) {
        const fullMd = data.data.content;
        // 找到"二、"的位置，截取之前的内容
        const cutIndex = fullMd.indexOf('二、');
        let md;
        if (cutIndex > 0) {
          // 往前找到上一个换行，确保不截断标题
          const lastNewline = fullMd.lastIndexOf('\n', cutIndex);
          md = fullMd.substring(0, lastNewline > 0 ? lastNewline : cutIndex);
        } else {
          md = fullMd;
        }
        contentEl.innerHTML = renderMarkdown(md);
      } else {
        const previewText = (latest.summary || '').length > 300 ? (latest.summary || '').substring(0, 300) + '...' : (latest.summary || '暂无内容');
        contentEl.innerHTML = `<div class="sumbox-dark">${escapeHtml(previewText)}</div>`;
      }
    })
    .catch(() => {
      const previewText = (latest.summary || '').length > 300 ? (latest.summary || '').substring(0, 300) + '...' : (latest.summary || '暂无内容');
      contentEl.innerHTML = `<div class="sumbox-dark">${escapeHtml(previewText)}</div>`;
    });

  // 历史报告列表（全部包含最新）
  let html = '';
  for (const report of reports) {
    const rc = report.risk_level === 'high' ? 'err' :
               report.risk_level === 'medium' ? 'warn' : 'ok';
    const rl = report.risk_level === 'high' ? '高风险' :
               report.risk_level === 'medium' ? '中风险' : '低风险';
    const st = report.summary || '无摘要';
    const pt = st.length > 80 ? st.substring(0, 80) + '...' : st;
    html += `
      <div class="rep-card" onclick="viewReport(${report.id})">
        <div class="rh">
          <span class="rt">${escapeHtml(report.title)}</span>
          <span class="tag ${rc}">${rl}</span>
        </div>
        <div class="rm">📅 ${formatDate(report.created_at)} 生成</div>
        <div class="rm">📊 ${report.twitter_count || 0} Twitter · ${report.discord_count || 0} Discord</div>
        <div class="rv">💡 核心观点：${escapeHtml(pt)}</div>
        <div style="margin-top:12px"><a class="btn-op" onclick="event.stopPropagation(); viewReport(${report.id})">查看</a><a class="btn-op" onclick="event.stopPropagation(); downloadReport(${report.id})">下载</a></div>
      </div>`;
  }
  container.innerHTML = html;
}

function viewCurrentReport() { if (currentReportId) viewReport(currentReportId); }
function downloadCurrentReport() { if (currentReportId) downloadReport(currentReportId); }

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

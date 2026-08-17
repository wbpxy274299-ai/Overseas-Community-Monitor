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
  
  // 元数据（报告实际覆盖三个平台，数据来源写全）
  document.getElementById('currentReportMeta').innerHTML = `生成于 ${formatDate(latest.created_at)}<br>数据来源：Twitter（Yahoo实时搜索）+ Discord（繁中服）+ Naver Lounge（韩服）`;
  
  // 统计卡片（★ 总量含韩服 Naver，与报告正文“合计”一致）
  const tw = latest.twitter_count || 0;
  const dc = latest.discord_count || 0;
  const lg = latest.lounge_count || 0;
  const total = tw + dc + lg;
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
        <div class="rm">📊 ${report.twitter_count || 0} Twitter · ${report.discord_count || 0} Discord${report.lounge_count ? ' · ' + report.lounge_count + ' Naver' : ''}</div>
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

// 查看报告详情（结构化阅读器）
async function viewReport(id) {
  try {
    const response = await fetch(`${SENTIMENT_API}/report/${id}`);
    const data = await response.json();
    if (data.ok) {
      const report = data.data;
      renderStructuredReport(report);
      openRpt('rptReport');
    } else {
      Toast.error('加载失败: ' + data.error);
    }
  } catch (error) {
    console.error('加载报告失败:', error);
    Toast.error('网络错误');
  }
}

/**
 * 渲染结构化报告到阅读器
 * ★ 直接复用 renderMarkdown 渲染完整 Markdown（支持表格/列表/引用/链接/四级标题），
 *   不再自行解析章节——旧版解析器会丢弃 ## 章节里 ### 之前的正文，且表格全部裸露原文
 */
function renderStructuredReport(report) {
  const { title, content, twitter_count, discord_count, risk_level, created_at } = report;
  const lg = report.lounge_count || 0;
  const total = (twitter_count || 0) + (discord_count || 0) + lg;

  // 更新元信息（★ 总量含韩服，与报告正文“合计”一致）
  const metaEl = document.getElementById('rptReportMeta');
  if (metaEl) {
    metaEl.innerHTML = `报告周期：${escapeHtml(title || '未知')} · 共 ${total} 条发言（Twitter ${twitter_count || 0} · Discord ${discord_count || 0}${lg > 0 ? ' · Naver ' + lg : ''}）<br>生成于 ${formatDate(created_at)}`;
  }

  // 章节导航：从正文提取 ## 二级标题
  const secTitles = [];
  String(content || '').replace(/^## (.+)$/gm, (m, t) => { secTitles.push(t.trim()); return m; });
  const navEl = document.getElementById('rptReportNav');
  if (navEl) {
    let navHtml = '<a onclick="rptGo(\'r-s-overview\')">总览</a>';
    secTitles.forEach((t, idx) => {
      navHtml += `<a onclick="rptGo('r-s-${idx}')">${escapeHtml(t)}</a>`;
    });
    navEl.innerHTML = navHtml;
  }

  // 渲染正文
  const bodyEl = document.getElementById('rptReportBody');
  if (!bodyEl) return;

  let html = '';

  // 总览区：统计卡片
  const riskClass = risk_level === 'high' ? '#E88B81' : risk_level === 'medium' ? 'var(--warn)' : '#7CC79A';
  const riskLabel = risk_level === 'high' ? '高' : risk_level === 'medium' ? '中' : '低';
  const colCount = lg > 0 ? 5 : 4;
  html += '<div class="rpt-sec" id="r-s-overview">总览</div>';
  html += `<div class="rpt-stat" style="grid-template-columns:repeat(${colCount},1fr)">`;
  html += `<div class="c"><div class="n">${total}</div><div class="t">总发言数</div></div>`;
  html += `<div class="c"><div class="n" style="color:#4A9EDA">${twitter_count || 0}</div><div class="t">Twitter</div></div>`;
  html += `<div class="c"><div class="n" style="color:#6A5ACD">${discord_count || 0}</div><div class="t">Discord</div></div>`;
  if (lg > 0) {
    html += `<div class="c"><div class="n" style="color:#E8A33D">${lg}</div><div class="t">Naver</div></div>`;
  }
  html += `<div class="c"><div class="n" style="color:${riskClass}">${riskLabel}</div><div class="t">风险等级</div></div>`;
  html += '</div>';

  // 正文：完整 Markdown 渲染，给每个 h2 章节标题挂锚点 id 供导航定位
  let secIdx = -1;
  html += renderMarkdown(content).replace(/<h2>/g, () => { secIdx++; return `<h2 id="r-s-${secIdx}">`; });

  bodyEl.innerHTML = html;
}

// 阅读器控制
function openRpt(id){ document.getElementById(id).classList.add('open'); document.body.style.overflow='hidden'; }
function closeRpt(id){ document.getElementById(id).classList.remove('open'); document.body.style.overflow=''; }
function rptGo(secId){ var el=document.getElementById(secId); if(el) el.scrollIntoView({behavior:'smooth',block:'start'}); }

// 复制总结
function copyReportSummary() {
  const body = document.getElementById('rptReportBody');
  if (body) {
    const text = body.innerText;
    navigator.clipboard.writeText(text).then(() => {
      Toast.success('已复制到剪贴板');
    }).catch(() => {
      Toast.error('复制失败');
    });
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
  let tableHeaderDone = false; // ★ 首行渲染为表头 th，分隔行跳过，其余为 td

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^-{3,}$/.test(trimmed) || /^---$/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; tableHeaderDone = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<hr>'; continue;
    }
    if (/^#### .+/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; tableHeaderDone = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h4>' + applyInline(trimmed.slice(5)) + '</h4>'; continue;
    }
    if (/^### .+/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; tableHeaderDone = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h3>' + applyInline(trimmed.slice(4)) + '</h3>'; continue;
    }
    if (/^## .+/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; tableHeaderDone = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h2>' + applyInline(trimmed.slice(3)) + '</h2>'; continue;
    }
    if (/^# .+/.test(trimmed)) {
      if (inTable) { html += '</table>'; inTable = false; tableHeaderDone = false; }
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h1>' + applyInline(trimmed.slice(2)) + '</h1>'; continue;
    }
    if (/^\|.+\|$/.test(trimmed)) {
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
      if (inList) { html += '</ul>'; inList = false; }
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      // 分隔行（|:---:|）：在开表之前就跳过，避免误当数据行
      if (cells.length > 0 && cells.every(c => /^[-:]+$/.test(c))) continue;
      if (!inTable) { html += '<table>'; inTable = true; tableHeaderDone = false; }
      const tag = tableHeaderDone ? 'td' : 'th';
      tableHeaderDone = true;
      html += '<tr>' + cells.map(c => `<${tag}>${applyInline(c)}</${tag}>`).join('') + '</tr>';
      continue;
    } else if (inTable) { html += '</table>'; inTable = false; tableHeaderDone = false; }
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
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // ★ 超链接：只允许 http(s) 协议，防 javascript: 伪协议（文本已提前 escapeHtml）
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) =>
      /^https?:\/\//i.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : label);
}

// 点击阅读器外部关闭
document.addEventListener('click', (e) => {
  const mask = document.getElementById('rptReport');
  if (mask && e.target === mask) closeRpt('rptReport');
});

window.addEventListener('DOMContentLoaded', () => { loadReports(); });

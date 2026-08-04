/**
 * 玩家洞察 — 页面逻辑
 * 调用后端 AI 分析接口，渲染结构化报告（Tab 导航 + 统计卡片 + 分区排版）
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

/**
 * 解析 Markdown 报告为结构化数据
 * 后端返回格式：
 * ## 🇹🇼 繁中服（Discord）
 * ### ① 玩家意见/建议概述
 * ### ② 玩家原声
 * ### ③ 需求洞察
 * ## 🇯🇵 日本（Twitter）
 * ...
 */
function parseReportMarkdown(md) {
  const lines = String(md).split('\n');
  const sections = [];
  let currentSection = null;
  let currentSubsection = null;
  let currentContent = [];

  const flushSubsection = () => {
    if (currentSubsection && currentContent.length > 0) {
      currentSubsection.content = currentContent.join('\n').trim();
      currentSection.subsections.push(currentSubsection);
    }
    currentSubsection = null;
    currentContent = [];
  };

  const flushSection = () => {
    flushSubsection();
    if (currentSection) sections.push(currentSection);
    currentSection = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 二级标题：## 🇼 繁中服（Discord）或 ## 🇯🇵 日本（Twitter）
    if (/^## (.+)/.test(line)) {
      flushSection();
      const title = line.replace(/^## /, '').trim();
      // 提取平台标识
      let platform = 'other';
      let platformLabel = title;
      if (title.includes('繁中服') || title.includes('Discord')) {
        platform = 'discord';
      } else if (title.includes('日本') || title.includes('Twitter')) {
        platform = 'twitter';
      } else if (title.includes('韩服') || title.includes('Naver') || title.includes('Lounge')) {
        platform = 'lounge';
      }
      currentSection = { title, platform, platformLabel, subsections: [] };
      continue;
    }

    // 三级标题：### ① 玩家意见/建议概述
    if (/^### (.+)/.test(line)) {
      flushSubsection();
      const title = line.replace(/^### /, '').trim();
      currentSubsection = { title, content: '' };
      continue;
    }

    // 内容行
    if (currentSubsection) {
      currentContent.push(line);
    }
  }

  // 刷新最后一个
  flushSubsection();
  flushSection();

  return sections;
}

/**
 * 渲染结构化报告到阅读器
 */
function renderStructuredReport(reportData, stats) {
  const { content, period, twitter_count, discord_count, total_records } = reportData;
  const lounge_count = reportData.lounge_count || stats?.lounge || 0;
  const sections = parseReportMarkdown(content);

  // 更新元信息
  const metaEl = document.getElementById('rptMeta');
  if (metaEl) {
    metaEl.innerHTML = ` 分析周期：${period} · 共 ${total_records} 条发言（JP ${twitter_count} · TW ${discord_count}${lounge_count > 0 ? ' · KR ' + lounge_count : ''}）<br> AI 驱动的玩家需求分析`;
  }

  // 渲染 Tab 导航
  const navEl = document.getElementById('rptNav');
  if (navEl) {
    let navHtml = '<a onclick="rptGo(\'i-s-overview\')">总览</a>';
    sections.forEach((sec, idx) => {
      navHtml += `<a onclick="rptGo('i-s-${idx}')">${escapeHtml(sec.platformLabel)}</a>`;
    });
    navEl.innerHTML = navHtml;
  }

  // 渲染正文
  const bodyEl = document.getElementById('rptBody');
  if (!bodyEl) return;

  let html = '';

  // 总览区：统计卡片
  const colCount = lounge_count > 0 ? 4 : 3;
  html += '<div class="rpt-sec" id="i-s-overview">总览</div>';
  html += `<div class="rpt-stat" style="grid-template-columns:repeat(${colCount},1fr)">`;
  html += `<div class="c"><div class="n">${total_records}</div><div class="t">总发言数</div></div>`;
  html += `<div class="c"><div class="n" style="color:#7FBCE8">${twitter_count}</div><div class="t">JP Twitter</div></div>`;
  html += `<div class="c"><div class="n" style="color:#B0A4F0">${discord_count}</div><div class="t">TW Discord</div></div>`;
  if (lounge_count > 0) {
    html += `<div class="c"><div class="n" style="color:#E8A33D">${lounge_count}</div><div class="t">KR Naver</div></div>`;
  }
  html += '</div>';

  // 各平台分区
  sections.forEach((sec, idx) => {
    html += `<div class="rpt-sec" id="i-s-${idx}">${escapeHtml(sec.platformLabel)}</div>`;

    sec.subsections.forEach(sub => {
      const subTitle = sub.title;
      const subContent = sub.content;

      if (subTitle.includes('概述')) {
        // ① 玩家意见/建议概述
        html += `<div class="rpt-subtitle">① 玩家意见/建议概述</div>`;
        html += `<div class="rpt-sumbox">${renderInlineMarkdown(subContent)}</div>`;
      } else if (subTitle.includes('原声')) {
        // ② 玩家原声
        html += `<div class="rpt-subtitle">② 玩家原声</div>`;
        html += renderPlayerQuotes(subContent, sec.platform);
      } else if (subTitle.includes('洞察')) {
        // ③ 需求洞察
        html += `<div class="rpt-subtitle">③ 需求洞察</div>`;
        html += `<div class="rpt-sumbox">${renderInlineMarkdown(subContent)}</div>`;
      } else {
        // 其他子章节
        html += `<div class="rpt-subtitle">${escapeHtml(subTitle)}</div>`;
        html += `<div class="rpt-sumbox">${renderInlineMarkdown(subContent)}</div>`;
      }
    });
  });

  bodyEl.innerHTML = html;
}

/**
 * 渲染玩家原声（处理引用格式）
 * 格式：> 「玩家原话」—— 玩家昵称
 * 或：> 「日语原文」—— 玩家昵称
 *     > [中文翻译] 翻译内容
 */
function renderPlayerQuotes(content, platform) {
  const lines = content.split('\n');
  let html = '';
  let currentQuote = null;
  let currentAuthor = '';
  let currentTranslation = '';

  const flushQuote = () => {
    if (currentQuote) {
      html += '<div class="rpt-quote">';
      html += `<div class="q">${escapeHtml(currentQuote)}`;
      if (currentTranslation) {
        html += `<br><span class="translation">[中文翻译] ${escapeHtml(currentTranslation)}</span>`;
      }
      html += '</div>';
      if (currentAuthor) {
        html += `<div class="a"> ${escapeHtml(currentAuthor)}</div>`;
      }
      html += '</div>';
    }
    currentQuote = null;
    currentAuthor = '';
    currentTranslation = '';
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // 引用行：> 「内容」—— 作者
    if (trimmed.startsWith('> ')) {
      const quoteLine = trimmed.substring(2);

      // 检查是否是翻译行
      if (quoteLine.startsWith('[中文翻译]') || quoteLine.startsWith('[翻译]')) {
        currentTranslation = quoteLine.replace(/^\[(中文翻译|翻译)\]\s*/, '');
        continue;
      }

      // 新的引用
      flushQuote();

      // 提取作者（—— 或 - 后面）
      const authorMatch = quoteLine.match(/(.+?)[—\-]\s*(.+)$/);
      if (authorMatch) {
        currentQuote = authorMatch[1].trim();
        currentAuthor = authorMatch[2].trim();
      } else {
        currentQuote = quoteLine;
      }
    } else if (trimmed) {
      // 非引用行，可能是作者名或其他内容
      if (trimmed.startsWith('👤') || trimmed.startsWith('@')) {
        currentAuthor = trimmed.replace(/^[👤@]\s*/, '');
      }
    }
  }

  flushQuote();
  return html;
}

/**
 * 简单的行内 Markdown 渲染（粗体、斜体、换行）
 */
function renderInlineMarkdown(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
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
      viewReport(data.data[0].id, {silent:true});
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
        <span class="chip" style="padding:2px 8px;font-size:10px">${r.total_records} 条数据 · JP ${r.twitter_count} · TW ${r.discord_count}${r.lounge_count ? ' · KR ' + r.lounge_count : ''}</span>
      </div>
      <div class="rm">📅 生成于 ${formatDate(r.created_at)}</div>
      <div style="margin-top:12px"><a class="btn-op" onclick="event.stopPropagation(); viewReport(${r.id})">查看</a><a class="btn-op danger" onclick="event.stopPropagation(); deleteReport(${r.id})">删除</a></div>
    </div>
  `).join('');
}

// 查看历史报告
async function viewReport(id, opts) {
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
      // 韩服统计（如果HTML中有该元素）
      const statLounge = document.getElementById('statLounge');
      if (statLounge) statLounge.textContent = r.lounge_count || 0;
      document.getElementById('statPeriod').textContent = r.period;
      document.getElementById('periodLabel').textContent = '分析周期 · ' + r.period;
      const emptyLabel = document.getElementById('emptyPeriodLabel');
      if (emptyLabel) emptyLabel.textContent = 'Current Insight · 分析周期 ' + r.period;

      // 结构化渲染到阅读器
      renderStructuredReport(r, {
        total: r.total_records,
        twitter: r.twitter_count,
        discord: r.discord_count,
        lounge: r.lounge_count || 0
      });

      // 更新 reportArea 显示"查看完整报告"按钮
      reportArea.innerHTML = '<div class="panel-cut" style="padding:28px 28px 26px;text-align:center">'
        + '<div style="font-size:16px;font-weight:700;color:#F2F2F0;margin-bottom:14px">报告已生成，正文已移入阅读器</div>'
        + '<button class="btn btn-light" onclick="openRpt(\'rptInsight\')">查看完整报告 <span class="ar">→</span></button></div>';

      if (!(opts && opts.silent)) openRpt('rptInsight');
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
      const statLounge2 = document.getElementById('statLounge');
      if (statLounge2) statLounge2.textContent = data.loungeCount || 0;
      document.getElementById('statPeriod').textContent = data.period;
      document.getElementById('periodLabel').textContent = '分析周期 · ' + data.period;
      const emptyLabel = document.getElementById('emptyPeriodLabel');
      if (emptyLabel) emptyLabel.textContent = 'Current Insight · 分析周期 ' + data.period;

      // 结构化渲染到阅读器
      renderStructuredReport({
        content: data.report,
        period: data.period,
        twitter_count: data.twitterCount,
        discord_count: data.discordCount,
        lounge_count: data.loungeCount || 0,
        total_records: data.totalRecords
      });

      // 更新 reportArea 显示"查看完整报告"按钮
      reportArea.innerHTML = '<div class="panel-cut" style="padding:28px 28px 26px;text-align:center">'
        + '<div style="font-size:16px;font-weight:700;color:#F2F2F0;margin-bottom:14px">报告已生成，正文已移入阅读器</div>'
        + '<button class="btn btn-light" onclick="openRpt(\'rptInsight\')">查看完整报告 <span class="ar">→</span></button></div>';

      openRpt('rptInsight');
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
  btn.textContent = ' 生成洞察报告';
}

window.addEventListener('DOMContentLoaded', () => {
  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (!user) { window.location.href = '/login'; return; }
  initPage();
});

// ===== 报告阅读器（V45 结构化版）=====
function openRpt(id){ document.getElementById(id).classList.add('open'); document.body.style.overflow='hidden'; }
function closeRpt(id){ document.getElementById(id).classList.remove('open'); document.body.style.overflow=''; }
function rptGo(secId){ var el=document.getElementById(secId); if(el) el.scrollIntoView({behavior:'smooth',block:'start'}); }

// 复制总结
function copyReportSummary() {
  const body = document.getElementById('rptBody');
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
function downloadReport() {
  const body = document.getElementById('rptBody');
  if (body) {
    const text = body.innerText;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'M2G_玩家洞察报告_' + new Date().toISOString().split('T')[0] + '.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
}

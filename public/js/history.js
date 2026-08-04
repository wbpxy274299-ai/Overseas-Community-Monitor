/**
 * 历史数据 — 页面逻辑
 */
let currentPage = 1;
const pageSize = 50;
let totalRecords = 0;
let currentFilters = {};

// 初始化日期（默认最近7天）
function initDates() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  document.getElementById('endDate').value = formatDateInput(endDate);
  document.getElementById('startDate').value = formatDateInput(startDate);
  document.getElementById('platformFilter').value = '';
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 加载数据
async function loadData(page = 1) {
  currentPage = page;
  const platform = document.getElementById('platformFilter').value;
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  currentFilters = { platform, startDate, endDate };

  document.getElementById('loadingState').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('dataTable').style.display = 'none';
  document.getElementById('pagination').style.display = 'none';

  try {
    const params = new URLSearchParams({ page: currentPage, pageSize, ...currentFilters });
    const response = await fetch(`/api/sentiment/history?${params}`);
    const result = await response.json();
    if (!result.success) throw new Error(result.error || '加载失败');
    totalRecords = result.total;
    renderTable(result.data);
    renderPagination(result.total, pageSize, currentPage);
  } catch (error) {
    console.error('加载数据失败:', error);
    alert('加载数据失败: ' + error.message);
  } finally {
    document.getElementById('loadingState').style.display = 'none';
  }
}

// 渲染表格
function renderTable(data) {
  const tbody = document.getElementById('tableBody');
  if (!data || data.length === 0) {
    document.getElementById('emptyState').style.display = 'block';
    return;
  }
  document.getElementById('dataTable').style.display = 'table';
  tbody.innerHTML = data.map(item => {
    const platformClass = item.platform === 'twitter' ? 'platform-twitter' : 'platform-discord';
    const platformText = item.platform === 'twitter' ? 'Twitter' : 'Discord';
    const mediaBadge = item.has_media ? '<span class="media-badge">📷 有媒体</span>' : '';
    const urlLink = item.url ? `<a href="${item.url}" target="_blank" class="url-link">查看原帖 →</a>` : '-';
    const timeDisplay = formatTimestamp(item.created_at);
    return `
      <tr>
        <td><span class="platform-badge ${platformClass}">${platformText}</span></td>
        <td>${escapeHtml(item.author || '匿名')}</td>
        <td>${timeDisplay}</td>
        <td class="content-cell">${escapeHtml(item.translated_content || item.content || '')}${mediaBadge}</td>
        <td>${urlLink}</td>
      </tr>`;
  }).join('');
}

// 渲染分页
function renderPagination(total, pageSize, current) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) {
    document.getElementById('pagination').style.display = 'none';
    return;
  }
  document.getElementById('pagination').style.display = 'flex';
  document.getElementById('pageInfo').textContent = `第 ${current} 页 / 共 ${totalPages} 页（共 ${total} 条）`;
  document.getElementById('prevBtn').disabled = current === 1;
  document.getElementById('nextBtn').disabled = current === totalPages;
}

// 切换页码
function changePage(delta) {
  loadData(currentPage + delta);
}

// ===== 手动上传功能 =====
function onCsvFileSelected(input) {
  const nameEl = document.getElementById('csvFileName');
  if (nameEl) nameEl.textContent = input.files.length ? input.files[0].name : '未选择任何文件';
}

function toggleUploadPanel() {
  const panel = document.getElementById('uploadPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function switchUploadTab(type) {
  const twBtn = document.getElementById('uploadTabTwitter');
  const dcBtn = document.getElementById('uploadTabDiscord');
  const twDiv = document.getElementById('uploadTwitter');
  const dcDiv = document.getElementById('uploadDiscord');
  if (type === 'twitter') {
    twBtn.className = 'btn btn-primary btn-sm';
    dcBtn.className = 'btn btn-secondary btn-sm';
    twDiv.style.display = 'block';
    dcDiv.style.display = 'none';
  } else {
    twBtn.className = 'btn btn-secondary btn-sm';
    dcBtn.className = 'btn btn-primary btn-sm';
    twDiv.style.display = 'none';
    dcDiv.style.display = 'block';
  }
  document.getElementById('uploadResult').innerHTML = '';
}

async function uploadTwitterCSV() {
  const fileInput = document.getElementById('twitterCsvFile');
  const resultDiv = document.getElementById('uploadResult');
  if (!fileInput.files.length) {
    resultDiv.innerHTML = '<span style="color:#ef4444;">请先选择 CSV 文件</span>';
    return;
  }
  resultDiv.innerHTML = '<span style="color:#3b82f6;">读取文件中...</span>';
  try {
    const file = fileInput.files[0];
    // 用 ArrayBuffer 读原始字节，防止编码不对变乱码
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    
    // 自动检测编码（比喻：先闻一闻邮件用的什么语言写的）
    let text;
    if (typeof jschardet !== 'undefined') {
      const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
      const detected = jschardet.detect(binary);
      const encoding = (detected.encoding || 'utf-8').toLowerCase();
      console.log(`📂 CSV 编码检测: ${encoding} (可信度: ${(detected.confidence * 100).toFixed(0)}%)`);
      
      // 编码映射：jschardet 返回的名称 → TextDecoder 支持的名称
      const encodingMap = {
        'shift_jis': 'shift-jis', 'shift-jis': 'shift-jis', 'sjis': 'shift-jis',
        'euc-jp': 'euc-jp', 'eucjp': 'euc-jp',
        'gb2312': 'gbk', 'gbk': 'gbk', 'gb18030': 'gbk',
        'big5': 'big5',
        'utf-8': 'utf-8', 'ascii': 'utf-8',
      };
      const decoderEncoding = encodingMap[encoding] || encoding;
      
      try {
        text = new TextDecoder(decoderEncoding).decode(bytes);
      } catch (e) {
        console.warn(`⚠️ ${decoderEncoding} 解码失败，回退 UTF-8`, e.message);
        text = new TextDecoder('utf-8').decode(bytes);
      }
    } else {
      // jschardet 加载失败，直接 UTF-8
      text = new TextDecoder('utf-8').decode(bytes);
    }
    
    resultDiv.innerHTML = '<span style="color:#3b82f6;">上传处理中...</span>';
    const res = await fetch('/api/sentiment/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'twitter', data: text })
    });
    const result = await res.json();
    if (result.ok) {
      resultDiv.innerHTML = `<span style="color:#059669;">✅ 上传成功：解析 ${result.parsed} 条，保存 ${result.saved} 条，跳过 ${result.skipped} 条</span>`;
      setTimeout(() => loadData(currentPage), 1500);
    } else {
      resultDiv.innerHTML = `<span style="color:#ef4444;">❌ ${result.message || result.error}</span>`;
    }
  } catch (e) {
    resultDiv.innerHTML = `<span style="color:#ef4444;">❌ 上传失败: ${e.message}</span>`;
  }
}

async function uploadDiscordText() {
  const textInput = document.getElementById('discordTextInput');
  const resultDiv = document.getElementById('uploadResult');
  const text = textInput.value.trim();
  if (!text) {
    resultDiv.innerHTML = '<span style="color:#ef4444;">请先粘贴 Discord 聊天记录</span>';
    return;
  }
  resultDiv.innerHTML = '<span style="color:#3b82f6;">上传处理中...</span>';
  try {
    const res = await fetch('/api/sentiment/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'discord', data: text })
    });
    const result = await res.json();
    if (result.ok) {
      resultDiv.innerHTML = `<span style="color:#059669;">✅ 上传成功：解析 ${result.parsed} 条，保存 ${result.saved} 条，跳过 ${result.skipped} 条</span>`;
      textInput.value = '';
      setTimeout(() => loadData(currentPage), 1500);
    } else {
      resultDiv.innerHTML = `<span style="color:#ef4444;">❌ ${result.message || result.error}</span>`;
    }
  } catch (e) {
    resultDiv.innerHTML = `<span style="color:#ef4444;">❌ 上传失败: ${e.message}</span>`;
  }
}

// ===== Tab 切换 =====
let currentHistoryTab = 'tw-dc';

function switchHistoryTab(tab) {
  currentHistoryTab = tab;
  document.querySelectorAll('.tab-card').forEach(btn => {
    btn.classList.toggle('on', btn.getAttribute('onclick') && btn.getAttribute('onclick').includes("'" + tab + "'"));
  });
  document.getElementById('tabTwDc').style.display = tab === 'tw-dc' ? '' : 'none';
  document.getElementById('tabKorean').style.display = tab === 'korean' ? '' : 'none';
  // 切到韩国tab时自动加载数据
  if (tab === 'korean' && document.getElementById('loungeList').innerHTML === '') {
    initLoungeDates();
    loadLoungePosts();
  }
}

// 页面加载时初始化
window.onload = () => { initDates(); loadData(); checkRunningCollection(); loadLoungeCrawlStatus(); };

// ===== 数据采集（从舆情页面搬过来） =====
let collectPollTimer = null;

async function startCollecting() {
  const btn = document.getElementById('btnCollect');
  if (btn.disabled) return;

  // 先检查是否已有进行中的采集
  try {
    const progressRes = await fetch('/api/sentiment/collect-progress');
    const progressData = await progressRes.json();
    if (progressData.ok && progressData.data.running) {
      showCollectProgress(progressData.data);
      startProgressPolling();
      return;
    }
  } catch (_) {}

  btn.disabled = true;
  btn.textContent = '⏳ 启动中...';

  try {
    const res = await fetch('/api/sentiment/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await res.json();

    if (result.ok) {
      showCollectProgress({ running: true, phase: 'twitter', message: '正在启动采集...', elapsed: 0 });
      startProgressPolling();
    } else if (result.collecting) {
      btn.textContent = '⏳ 采集中...';
      showCollectProgress({ running: true, phase: '', message: '采集进行中...', elapsed: 0 });
      startProgressPolling();
    } else {
      alert(result.message || '启动失败');
      btn.disabled = false;
      btn.textContent = '▶ 启动抓取';
    }
  } catch (e) {
    alert('采集请求失败: ' + e.message);
    btn.disabled = false;
    btn.textContent = '▶ 启动抓取';
  }
}

function startProgressPolling() {
  if (collectPollTimer) clearInterval(collectPollTimer);
  collectPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/sentiment/collect-progress');
      const result = await res.json();
      if (result.ok) {
        showCollectProgress(result.data);
        if (!result.data.running) {
          clearInterval(collectPollTimer);
          collectPollTimer = null;
          showCollectResult(result.data);
          // 3秒后自动刷新表格
          setTimeout(() => loadData(currentPage), 3000);
        }
      }
    } catch (_) {}
  }, 2000);
}

function showCollectProgress(data) {
  const bar = document.getElementById('collectProgressBar');
  const fill = document.getElementById('collectProgressFill');
  const icon = document.getElementById('collectProgressIcon');
  const text = document.getElementById('collectProgressText');
  const elapsed = document.getElementById('collectProgressElapsed');
  const detail = document.getElementById('collectProgressDetail');
  const btn = document.getElementById('btnCollect');

  bar.style.display = 'block';
  text.textContent = data.message || '准备中...';
  elapsed.textContent = data.elapsed ? `${data.elapsed}秒` : '';

  let percent = 0;
  if (data.phase === 'twitter') { icon.textContent = '🐦'; percent = 15; }
  else if (data.phase === 'discord') { icon.textContent = '💬'; percent = 40; }
  else if (data.phase === 'cleaning') { icon.textContent = '🧹'; percent = 60; }
  else if (data.phase === 'saving') { icon.textContent = '💾'; percent = 80; }
  else if (data.phase === 'done') { icon.textContent = '✅'; percent = 100; fill.className = 'collect-progress-fill done'; }
  else if (data.phase === 'error') { icon.textContent = '❌'; percent = 100; fill.className = 'collect-progress-fill error'; }
  else { icon.textContent = '⏳'; percent = 5; }
  fill.style.width = percent + '%';

  let parts = [];
  if (data.twitterCount > 0) parts.push(`🐦 Twitter: ${data.twitterCount}`);
  if (data.discordCount > 0) parts.push(`💬 Discord: ${data.discordCount}`);
  if (data.dedupCount > 0) parts.push(`🧹 去重: ${data.dedupCount}`);
  if (data.officialCount > 0) parts.push(`📤 过滤官方: ${data.officialCount}`);
  if (data.translateCount > 0) parts.push(`🌐 翻译: ${data.translateCount}`);
  if (data.savedCount > 0) parts.push(`✅ 保存: ${data.savedCount}`);
  if (data.skippedCount > 0) parts.push(`⏭️ 跳过: ${data.skippedCount}`);
  if (data.failedCount > 0) parts.push(`❌ 失败: ${data.failedCount}`);
  detail.textContent = parts.join('  ·  ');

  if (data.running) {
    btn.disabled = true;
    btn.textContent = '⏳ 采集中...';
  } else {
    btn.disabled = false;
    btn.textContent = '▶ 启动抓取';
    setTimeout(() => { if (!data.running) { bar.style.display = 'none'; fill.className = 'collect-progress-fill'; } }, 15000);
  }
}

function showCollectResult(data) {
  const el = document.getElementById('collectResult');
  if (!el) return;
  if (data.phase === 'error') {
    el.style.display = 'block';
    el.innerHTML = `<div class="result-error">❌ ${data.message || '采集失败'}${data.errors && data.errors.length ? '<br>' + data.errors.map(e => `<span>${e.source}: ${e.message}</span>`).join('<br>') : ''}</div>`;
    return;
  }
  el.style.display = 'block';
  const items = [
    `<span class="result-item result-success">✅ 新增 ${data.savedCount} 条</span>`,
    `<span class="result-item">🐦 Twitter ${data.twitterCount} 条</span>`,
    `<span class="result-item">💬 Discord ${data.discordCount} 条</span>`,
  ];
  if (data.dedupCount > 0) items.push(`<span class="result-item">🧹 去重 ${data.dedupCount} 条</span>`);
  if (data.officialCount > 0) items.push(`<span class="result-item result-official">📤 过滤官方 ${data.officialCount} 条（已转至意见反馈）</span>`);
  if (data.translateCount > 0) items.push(`<span class="result-item">🌐 翻译 ${data.translateCount} 条</span>`);
  if (data.skippedCount > 0) items.push(`<span class="result-item result-muted">⏭️ 跳过 ${data.skippedCount} 条</span>`);
  if (data.errors && data.errors.length > 0) {
    items.push(`<div class="result-errors">${data.errors.map(e => `⚠️ ${e.source}: ${e.message}`).join('<br>')}</div>`);
  }
  el.innerHTML = items.join('');
}

async function checkRunningCollection() {
  try {
    const res = await fetch('/api/sentiment/collect-progress');
    const result = await res.json();
    if (result.ok && result.data.running) {
      showCollectProgress(result.data);
      startProgressPolling();
    }
  } catch (_) {}
}

// ===== 韩国社区爬虫触发 =====
async function triggerLoungeCrawl() {
  const btn = document.getElementById('btnLoungeCrawl');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '⏳ 启动中...';
  try {
    const res = await fetch('/api/lounge/crawl', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const result = await res.json();
    if (result.success) {
      btn.textContent = '⏳ 抓取中...';
      startLoungeCrawlPolling();
    } else {
      alert(result.message || '启动失败');
      btn.disabled = false;
      btn.textContent = '🔄 立即抓取';
    }
  } catch (e) {
    alert('抓取请求失败: ' + e.message);
    btn.disabled = false;
    btn.textContent = '🔄 立即抓取';
  }
}

let loungeCrawlPollTimer = null;

function startLoungeCrawlPolling() {
  if (loungeCrawlPollTimer) clearInterval(loungeCrawlPollTimer);
  loungeCrawlPollTimer = setInterval(loadLoungeCrawlStatus, 3000);
  // 最多轮询5分钟
  setTimeout(() => {
    if (loungeCrawlPollTimer) { clearInterval(loungeCrawlPollTimer); loungeCrawlPollTimer = null; }
    const btn = document.getElementById('btnLoungeCrawl');
    if (btn) { btn.disabled = false; btn.textContent = '🔄 立即抓取'; }
  }, 300000);
}

async function loadLoungeCrawlStatus() {
  try {
    const res = await fetch('/api/lounge/status');
    const result = await res.json();
    if (!result.success) return;
    const data = result.data;
    const statusEl = document.getElementById('loungeCrawlStatus');
    const btn = document.getElementById('btnLoungeCrawl');
    if (statusEl) {
      const stats = data.stats || {};
      const parts = [];
      if (stats.total_posts) parts.push(`📝 ${stats.total_posts} 条帖子`);
      if (stats.translated) parts.push(`🌐 ${stats.translated} 条已翻译`);
      statusEl.textContent = parts.join(' · ') || '--';
    }
    if (btn) {
      if (data.isCrawling) {
        btn.disabled = true;
        btn.textContent = '⏳ 抓取中...';
        if (!loungeCrawlPollTimer) startLoungeCrawlPolling();
      } else {
        btn.disabled = false;
        btn.textContent = '🔄 立即抓取';
        if (loungeCrawlPollTimer) {
          clearInterval(loungeCrawlPollTimer);
          loungeCrawlPollTimer = null;
          // 抓取完成后刷新帖子列表
          if (currentHistoryTab === 'korean') loadLoungePosts();
        }
      }
    }
  } catch (_) {}
}

// ===== 韩国社区帖子 =====
let loungePage = 1;
const loungePageSize = 20;
let loungeTotal = 0;

function initLoungeDates() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  document.getElementById('loungeEndDate').value = formatDateInput(endDate);
  document.getElementById('loungeStartDate').value = formatDateInput(startDate);
}

async function loadLoungePosts(page = 1) {
  loungePage = page;
  const sentiment = document.getElementById('loungeSentimentFilter')?.value || '';
  const category = document.getElementById('loungeCategoryFilter')?.value || '';
  const startDate = document.getElementById('loungeStartDate')?.value || '';
  const endDate = document.getElementById('loungeEndDate')?.value || '';

  document.getElementById('loungeLoading').style.display = 'block';
  document.getElementById('loungeEmpty').style.display = 'none';
  document.getElementById('loungeList').innerHTML = '';
  document.getElementById('loungePagination').style.display = 'none';

  try {
    const params = new URLSearchParams({ page: loungePage, pageSize: loungePageSize, startDate, endDate });
    if (sentiment) params.append('sentiment', sentiment);
    if (category) params.append('category', category);
    const res = await fetch(`/api/sentiment/lounge-posts?${params}`);
    const result = await res.json();
    if (!result.success) throw new Error(result.error);
    loungeTotal = result.total;
    document.getElementById('loungeTotal').textContent = `共 ${loungeTotal} 条`;
    renderLoungePosts(result.data);
    renderLoungePagination(result.total, loungePageSize, loungePage);
  } catch (e) {
    console.error('加载韩国帖子失败:', e);
    document.getElementById('loungeLoading').style.display = 'none';
    document.getElementById('loungeEmpty').style.display = 'block';
  }
}

function renderLoungePosts(posts) {
  document.getElementById('loungeLoading').style.display = 'none';
  if (!posts || posts.length === 0) {
    document.getElementById('loungeEmpty').style.display = 'block';
    return;
  }
  const sentIcon = s => s === 'negative' ? '😠' : s === 'positive' ? '😊' : '😐';
  const sentColor = s => s === 'negative' ? '#ef4444' : s === 'positive' ? '#22c55e' : '#6b7280';
  const sentLabel = s => s === 'negative' ? '负面' : s === 'positive' ? '正面' : '中性';
  const catLabel = c => ({ bug:'🐛 Bug', suggestion:'💡 建议', complaint:'😤 投诉', praise:'👍 好评', question:'❓ 提问', other:'其他' }[c] || c || '');

  let html = '';
  for (const p of posts) {
    const title = p.title_zh || p.title || '';
    const sIcon = sentIcon(p.sentiment);
    const sColor = sentColor(p.sentiment);
    const sLabel = sentLabel(p.sentiment);
    const cat = catLabel(p.ai_category);
    const cmtCount = p._comment_count || p.comment_count || 0;
    const time = (p.post_time || p.crawled_at || '').substring(5, 16);
    html += `<div class="lounge-card" onclick="openLoungePost('${p.post_id}','${escapeHtml(p.game_code)}')">
      <div class="lounge-card-top">
        <span class="lounge-sent-badge" style="background:${sColor}15;color:${sColor};">${sIcon} ${sLabel}</span>
        ${cat ? `<span class="lounge-cat-badge">${cat}</span>` : ''}
        <span class="lounge-time">${time}</span>
      </div>
      <div class="lounge-card-title">${escapeHtml(title)}</div>
      <div class="lounge-card-meta">
        👤 ${escapeHtml(p.author || '匿名')} · 👁 ${p.view_count||0} · 💬 ${cmtCount}条评论
        ${p.url ? ` · <a href="${p.url}" target="_blank" onclick="event.stopPropagation()">原帖↗</a>` : ''}
      </div>
    </div>`;
  }
  document.getElementById('loungeList').innerHTML = html;
}

function renderLoungePagination(total, pageSize, current) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) {
    document.getElementById('loungePagination').style.display = 'none';
    return;
  }
  document.getElementById('loungePagination').style.display = 'flex';
  document.getElementById('loungePageInfo').textContent = `第 ${current} 页 / 共 ${totalPages} 页（共 ${total} 条）`;
  document.getElementById('loungePrevBtn').disabled = current === 1;
  document.getElementById('loungeNextBtn').disabled = current === totalPages;
}

function changeLoungePage(delta) {
  loadLoungePosts(loungePage + delta);
}

async function openLoungePost(postId, gameCode) {
  const modal = document.getElementById('loungeModal');
  const title = document.getElementById('loungeModalTitle');
  const body = document.getElementById('loungeModalBody');
  modal.style.display = 'flex';
  title.textContent = '加载中...';
  body.innerHTML = '<div class="loading">加载中...</div>';
  try {
    const res = await fetch(`/api/sentiment/lounge-comments/${postId}`);
    const result = await res.json();
    if (!result.success) throw new Error(result.error);
    const post = result.post;
    const comments = result.data || [];
    // 帖子内容区
    let html = '';
    if (post) {
      const catLabel = c => ({ bug:'🐛 Bug', suggestion:'💡 建议', complaint:'😤 投诉', praise:'👍 好评', question:'❓ 提问', other:'其他' }[c] || '');
      const sentLabel = s => s === 'negative' ? '😠 负面' : s === 'positive' ? '😊 正面' : ' 中性';
      title.textContent = post.title_zh || post.title || '帖子详情';
      html += `<div class="lounge-post-detail">`;
      html += `<div class="lounge-post-meta">
        <span class="lounge-sent-badge">${sentLabel(post.sentiment)}</span>
        ${post.ai_category ? `<span class="lounge-cat-badge">${catLabel(post.ai_category)}</span>` : ''}
        <span class="lounge-post-author"> ${escapeHtml(post.author||'匿名')} ·  ${post.view_count||0} · 💬 ${post.comment_count||0}</span>
      </div>`;
      if (post.title_zh && post.title && post.title_zh !== post.title) {
        html += `<div class="lounge-post-korean-title">原标题: ${escapeHtml(post.title)}</div>`;
      }
      if (post.content_zh) {
        html += `<div class="lounge-post-content">${escapeHtml(post.content_zh)}</div>`;
      }
      if (post.content && post.content !== post.content_zh) {
        const origText = post.content.length > 300 ? post.content.substring(0, 300) + '...' : post.content;
        html += `<div class="lounge-post-original">原文: ${escapeHtml(origText)}</div>`;
      }
      if (post.url) {
        html += `<div class="lounge-post-url"><a href="${post.url}" target="_blank">查看原帖↗</a></div>`;
      }
      html += `</div>`;
    } else {
      title.textContent = '帖子详情';
    }
    // 评论区
    html += `<div class="lounge-comments-section">`;
    html += `<div class="lounge-comments-title">💬 评论 (${comments.length} 条)</div>`;
    if (comments.length === 0) {
      html += '<div class="lounge-no-comments">暂无评论</div>';
    } else {
      const sentIcon = s => s === 'negative' ? '😟' : s === 'positive' ? '😊' : '😐';
      for (const c of comments) {
        const text = c.content_zh || c.content || '';
        html += `<div class="lounge-comment">
          <div class="lounge-cmt-header">
            <span class="lounge-cmt-author">👤 ${escapeHtml(c.author || '匿名')}</span>
            <span class="lounge-cmt-sent">${sentIcon(c.sentiment)}</span>
            <span class="lounge-cmt-time">${c.comment_time || ''}</span>
            ${c.likes > 0 ? `<span class="lounge-cmt-likes">👍 ${c.likes}</span>` : ''}
          </div>
          <div class="lounge-cmt-text">${escapeHtml(text)}</div>
          ${c.content_zh && c.content && c.content_zh !== c.content ? `<div class="lounge-cmt-original">原文: ${escapeHtml(c.content.substring(0, 150))}${c.content.length > 150 ? '...' : ''}</div>` : ''}
        </div>`;
      }
    }
    html += '</div>';
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<div style="color:#ef4444;">加载失败: ${e.message}</div>`;
  }
}

function closeLoungeModal() {
  document.getElementById('loungeModal').style.display = 'none';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

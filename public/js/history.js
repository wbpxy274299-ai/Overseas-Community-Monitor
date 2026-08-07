/**
 * 历史数据 — 页面逻辑
 */
let currentPage = 1;
const pageSize = 50;
let totalRecords = 0;
let currentFilters = {};

// 初始化日期（默认最近7天）
function initDates() {
  // ★ 服务器已设 TZ=Asia/Shanghai，直接用本地时间
  const now = new Date();
  const endDate = new Date(now);
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 7);
  document.getElementById('endDate').value = formatDateInput(endDate);
  document.getElementById('startDate').value = formatDateInput(startDate);
  document.getElementById('platformFilter').value = '';
}

// 格式化韩国评论时间（兼容两种格式）
// 标准格式 "2026-04-04 19:29:48" -> "04-04 19:29"
// 紧凑格式 "20260404192948" -> "04-04 19:29"
function formatKrTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return '';
  // 标准格式: YYYY-MM-DD HH:MM:SS
  if (timeStr.includes('-') && timeStr.length >= 16) {
    return timeStr.substring(5, 16); // "MM-DD HH:MM"
  }
  // 紧凑格式: YYYYMMDDHHmmss
  if (timeStr.length >= 12) {
    const m = timeStr.substring(4, 6);
    const d = timeStr.substring(6, 8);
    const h = timeStr.substring(8, 10);
    const min = timeStr.substring(10, 12);
    return `${m}-${d} ${h}:${min}`;
  }
  return '';
}

// 解析数据库中的时间字符串（UTC+8，无时区标记）→ 正确的 Date 对象
function parseDBTime(timeStr) {
  if (!timeStr) return null;
  // 已经是 ISO 格式（带Z或+），直接解析
  if (timeStr.includes('Z') || /\+\d{2}:\d{2}$/.test(timeStr)) {
    const d = new Date(timeStr);
    return isNaN(d.getTime()) ? null : d;
  }
  // 数据库存的 UTC+8 时间（如 "2026-08-06 15:30:00"），补上 +08:00 让浏览器正确转换
  const d = new Date(timeStr.replace(' ', 'T') + '+08:00');
  return isNaN(d.getTime()) ? null : d;
}

// 格式化爬取时间（数据库存的是 UTC+8）
function formatCrawlTime(timeStr) {
  const d = parseDBTime(timeStr);
  if (!d) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

// 格式化发帖时间（post_time 是韩国时间 UTC+9）
function formatPostTime(timeStr) {
  if (!timeStr) return '';
  // post_time 是韩国本地时间 (UTC+9)，补上 +09:00 让浏览器正确转换到本地时区
  const match = timeStr.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (match) {
    const d = new Date(timeStr.replace(' ', 'T') + '+09:00');
    if (!isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${mm}-${dd} ${hh}:${min}`;
    }
    // 解析失败则回退到直接提取数字
    return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
  }
  return formatCrawlTime(timeStr);
}

function formatDateInput(date) {
  // ★ 服务器已设 TZ=Asia/Shanghai，直接用本地方法
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
    // 更新 Tab 计数角标
    const twDcCnt = document.getElementById('tabCntTwDc');
    if (twDcCnt) twDcCnt.textContent = `${result.total} 条`;
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
    const platformStyle = item.platform === 'twitter'
      ? 'padding:2px 8px;font-size:10px;color:#3A7FB5;border-color:rgba(74,158,218,.45)'
      : 'padding:2px 8px;font-size:10px;color:#6A5ACD;border-color:rgba(123,104,238,.45)';
    const platformText = item.platform === 'twitter' ? 'Twitter' : 'Discord';
    const mediaBadge = item.has_media ? '<span class="media-badge">📷 有媒体</span>' : '';
    const urlLink = item.url ? `<a class="oplink" href="${item.url}" target="_blank">查看原帖 →</a>` : '<span style="color:var(--mut)">-</span>';
    const timeDisplay = formatTimestamp(item.created_at);
    return `
      <tr>
        <td><span class="chip" style="${platformStyle}">${platformText}</span></td>
        <td class="strong">${escapeHtml(item.author || '匿名')}</td>
        <td class="mono">${timeDisplay}</td>
        <td style="max-width:520px">${escapeHtml(item.translated_content || item.content || '')}${mediaBadge}</td>
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
  document.getElementById('pagination').style.display = 'block';
  document.getElementById('pageInfo').textContent = `共 ${total} 条 · 第 ${current} 页 / 共 ${totalPages} 页`;
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
  document.getElementById('tabTwDc').classList.toggle('on', tab === 'tw-dc');
  document.getElementById('tabKorean').classList.toggle('on', tab === 'korean');
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

// ===== 韩国社区数据清空 =====
async function clearLoungeData() {
  if (!confirm('确认清空所有韩国社区数据？\n\n这将删除所有帖子、评论和日报，但不会影响用户账号。\n\n此操作不可恢复！')) return;
  try {
    const res = await fetch('/api/lounge/clear-data', { method: 'POST' });
    const result = await res.json();
    if (result.success) {
      alert(result.message || '数据已清空');
      // 刷新统计和列表
      initLoungeDates();
      loadLoungePosts();
      loadLoungeStats();
    } else {
      alert(result.message || '清空失败');
    }
  } catch (e) {
    alert('清空请求失败: ' + e.message);
  }
}

// ===== 删除指定日期之前的韩国社区数据 =====
async function deleteOldLoungeData() {
  if (!confirm('确认删除 2026-05-01 之前的所有韩国社区数据？\n\n这将删除旧帖子、评论和日报，但不会影响 5 月之后的数据。\n\n此操作不可恢复！')) return;
  try {
    const res = await fetch('/api/lounge/delete-before', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beforeDate: '2026-05-01' })
    });
    const result = await res.json();
    if (result.success) {
      alert(result.message || '删除完成');
      // 刷新统计和列表
      initLoungeDates();
      loadLoungePosts();
      loadLoungeStats();
    } else {
      alert(result.message || '删除失败');
    }
  } catch (e) {
    alert('删除请求失败: ' + e.message);
  }
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
    const infoEl = document.getElementById('loungeCrawlInfo');
    const btn = document.getElementById('btnLoungeCrawl');
    if (infoEl) {
      const stats = data.stats || {};
      const parts = [];
      if (stats.total_posts) parts.push(`${stats.total_posts} 条帖子`);
      if (stats.translated) parts.push(`${stats.translated} 条已翻译`);
      if (data.lastDuration) parts.push(`上次抓取用时 ${data.lastDuration} 秒`);
      parts.push('增量模式（仅抓新帖）');
      infoEl.textContent = parts.join(' · ') || '--';
    }
    if (btn) {
      if (data.isCrawling) {
        btn.disabled = true;
        btn.textContent = '⏳ 抓取中...';
        if (!loungeCrawlPollTimer) startLoungeCrawlPolling();
        // 更新进度条
        updateCrawlProgress(data.progress);
      } else {
        btn.disabled = false;
        btn.textContent = '🔄 立即抓取';
        if (loungeCrawlPollTimer) {
          clearInterval(loungeCrawlPollTimer);
          loungeCrawlPollTimer = null;
          // 抓取完成后刷新帖子列表
          if (currentHistoryTab === 'korean') loadLoungePosts();
          // 清除进度条
          clearCrawlProgress();
        }
      }
    }
  } catch (_) {}
}

// ===== 抓取进度显示 =====
function updateCrawlProgress(progress) {
  if (!progress) return;
  let bar = document.getElementById('crawlProgressBar');
  let label = document.getElementById('crawlProgressLabel');
  if (!bar) {
    // 创建进度条
    const container = document.createElement('div');
    container.id = 'crawlProgressContainer';
    container.style.cssText = 'margin-top:12px;padding:12px 16px;background:var(--panel-2);border-radius:12px;border:1px solid var(--line)';
    bar = document.createElement('div');
    bar.id = 'crawlProgressBar';
    bar.style.cssText = 'height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-bottom:8px';
    const fill = document.createElement('div');
    fill.id = 'crawlProgressFill';
    fill.style.cssText = 'height:100%;background:var(--ink);border-radius:3px;transition:width .3s;width:0%';
    bar.appendChild(fill);
    label = document.createElement('div');
    label.id = 'crawlProgressLabel';
    label.style.cssText = 'font-size:12px;color:var(--mut)';
    container.appendChild(bar);
    container.appendChild(label);
    const btn = document.getElementById('btnLoungeCrawl');
    if (btn && btn.parentNode) {
      btn.parentNode.insertBefore(container, btn.nextSibling);
    }
  }
  const fill = document.getElementById('crawlProgressFill');
  if (fill && progress.totalSteps > 0) {
    const pct = Math.min(100, Math.round((progress.currentStep / progress.totalSteps) * 100));
    fill.style.width = pct + '%';
  }
  if (label) {
    const parts = [progress.stepLabel || ''];
    if (progress.message) parts.push(progress.message);
    if (progress.postsFound) parts.push(`发现 ${progress.postsFound} 条`);
    if (progress.postsCrawled) parts.push(`已抓 ${progress.postsCrawled} 条`);
    label.textContent = parts.join(' · ');
  }
}

function clearCrawlProgress() {
  const container = document.getElementById('crawlProgressContainer');
  if (container) container.remove();
}

// ===== 韩国社区帖子 =====
let loungePage = 1;
const loungePageSize = 20;
let loungeTotal = 0;

function initLoungeDates() {
  // ★ 服务器已设 TZ=Asia/Shanghai，直接用本地时间
  const now = new Date();
  const endDate = new Date(now);
  const startDate = new Date(now);
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
    // 更新 Tab 计数角标
    const krCnt = document.getElementById('tabCntKr');
    if (krCnt) krCnt.textContent = `${result.total} 条`;
    renderLoungePosts(result.data);
    renderLoungePagination(result.total, loungePageSize, loungePage);
    // 加载统计概览
    loadLoungeStats();
  } catch (e) {
    console.error('加载韩国帖子失败:', e);
    document.getElementById('loungeLoading').style.display = 'none';
    document.getElementById('loungeEmpty').style.display = 'block';
  }
}

// 加载韩国社区统计概览
async function loadLoungeStats() {
  try {
    const res = await fetch('/api/sentiment/lounge-stats');
    const result = await res.json();
    if (!result.success) return;
    const total = result.totalPosts || 0;
    const translated = result.translated || 0;
    const pct = total > 0 ? Math.round(translated / total * 100) : 0;
    const lastCrawl = result.lastCrawl || '--';
    // 更新统计卡片
    const el = id => document.getElementById(id);
    if (el('statTotalPosts')) el('statTotalPosts').textContent = total;
    if (el('statTranslated')) el('statTranslated').textContent = translated;
    if (el('statTranslatePct')) el('statTranslatePct').textContent = pct + '%';
    if (el('statLastCrawl')) {
      // lastCrawl 是数据库 UTC+8 时间，用 parseDBTime 正确解析时区
      if (lastCrawl !== '--') {
        const d = parseDBTime(lastCrawl);
        if (d) {
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          const hh = String(d.getHours()).padStart(2, '0');
          const min = String(d.getMinutes()).padStart(2, '0');
          el('statLastCrawl').textContent = `${mm}-${dd} ${hh}:${min}`;
        }
      } else {
        el('statLastCrawl').textContent = '--';
      }
    }
    if (el('statProgressFill')) el('statProgressFill').style.width = pct + '%';
    // ★ Tab 计数角标由 loadLoungePosts 更新（显示查询结果数），此处不覆盖
  } catch (_) { /* 静默失败 */ }
}

function renderLoungePosts(posts) {
  document.getElementById('loungeLoading').style.display = 'none';
  if (!posts || posts.length === 0) {
    document.getElementById('loungeEmpty').style.display = 'block';
    return;
  }
  const sentTag = s => {
    if (s === 'negative') return { cls: 'err', label: '负面' };
    if (s === 'positive') return { cls: 'ok', label: '正面' };
    return { cls: 'warn', label: '中性' };
  };
  const catLabel = c => ({ bug:'🐛 Bug', suggestion:'💡 建议', complaint:'😤 投诉', praise:'👍 好评', question:'❓ 提问', event:'event', other:'其他' }[c] || c || '');

  let html = '';
  for (const p of posts) {
    const title = p.title_zh || p.title || '';
    const st = sentTag(p.sentiment);
    const cat = catLabel(p.ai_category);
    const cmtCount = p._comment_count || p.comment_count || 0;
    html += `<div class="fb-card" style="border-left-color:var(--${st.cls})" onclick="openLoungePost('${p.post_id}','${escapeHtml(p.game_code)}')">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <span class="tag ${st.cls}">${st.label}</span>
        ${cat ? `<span class="chip" style="padding:2px 8px;font-size:10px">${escapeHtml(cat)}</span>` : ''}
      </div>
      <div class="strong" style="font-size:14px">${escapeHtml(title)}</div>
      <div style="font-size:11px;color:var(--mut);margin-top:6px">
         ${escapeHtml(p.author || '匿名')} · ${p.post_time ? formatPostTime(p.post_time) : '抓取于 ' + formatCrawlTime(p.crawled_at)} · ${p.view_count||0} · 💬 ${cmtCount}条评论
        ${p.url ? ` · <a class="oplink" href="${p.url}" target="_blank" onclick="event.stopPropagation()">原帖 ↗</a>` : ''}
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
  document.getElementById('loungePagination').style.display = 'block';
  document.getElementById('loungePageInfo').textContent = `共 ${total} 条 · 第 ${current} 页 / 共 ${totalPages} 页`;
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
            <span class="lounge-cmt-time">${formatKrTime(c.comment_time) || ''}</span>
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

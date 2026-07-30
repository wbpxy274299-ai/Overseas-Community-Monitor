/**
 * 韩国社区监控 — 前端交互逻辑
 * 放在 public/js/lounge.js
 */

// ===== 页面初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  checkLoginAndInit();
});

async function checkLoginAndInit() {
  try {
    const res = await Api.get('/api/auth/verify');
    if (res.valid && res.user) {
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('mainApp').style.display = 'block';
      highlightNav();
      // 加载数据
      loadStatus();
      loadPosts();
      loadReport();
      // 每60秒自动刷新状态
      setInterval(loadStatus, 60000);
    } else {
      window.location.href = '/login';
    }
  } catch (e) {
    window.location.href = '/login';
  }
}

// ===== 加载爬虫状态 =====
async function loadStatus() {
  try {
    const res = await Api.get('/api/lounge/status');
    if (!res.success) return;

    const { data } = res;
    const statusEl = document.getElementById('crawlStatus');

    if (data.isCrawling) {
      statusEl.innerHTML = '🔄 正在抓取中...';
      statusEl.style.color = '#f59e0b';
    } else if (data.lastCrawlTime) {
      const t = new Date(data.lastCrawlTime).toLocaleString('zh-CN');
      statusEl.innerHTML = `上次抓取: ${t}`;
      statusEl.style.color = data.lastCrawlResult?.success ? '#22c55e' : '#ef4444';
    } else {
      statusEl.innerHTML = '尚未抓取';
      statusEl.style.color = '#999';
    }

    // 更新统计卡片
    if (data.stats) {
      document.getElementById('statPosts').textContent = data.stats.total_posts || 0;
      document.getElementById('statPositive').textContent = data.stats.positive || 0;
      document.getElementById('statNegative').textContent = data.stats.negative || 0;
      document.getElementById('statNeutral').textContent =
        (data.stats.total_posts || 0) - (data.stats.positive || 0) - (data.stats.negative || 0);
    }
  } catch (e) {
    console.error('加载状态失败:', e);
  }
}

// ===== 加载帖子列表 =====
let currentPage = 1;

async function loadPosts(page = 1) {
  currentPage = page;
  const listEl = document.getElementById('postList');
  listEl.innerHTML = '<div class="loading-placeholder">⏳ 加载中...</div>';

  try {
    const sentiment = document.getElementById('filterSentiment').value;
    const keyword = document.getElementById('filterKeyword').value.trim();

    let url = `/api/lounge/posts?page=${page}&size=20`;
    if (sentiment) url += `&sentiment=${sentiment}`;
    if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;

    const res = await Api.get(url);
    if (!res.success) {
      listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">😕</div><p>加载失败</p></div>';
      return;
    }

    const posts = res.data;
    if (posts.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <p>暂无帖子数据</p>
          <p style="font-size:12px;color:#ccc;">点击右上角「立即抓取」开始采集韩国社区数据</p>
        </div>`;
      return;
    }

    listEl.innerHTML = posts.map(post => renderPostCard(post)).join('');
    renderPagination(res.pagination);

  } catch (e) {
    listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">❌</div><p>网络错误</p></div>';
  }
}

// ===== 渲染帖子卡片 =====
function renderPostCard(post) {
  const sentimentMap = {
    positive: { label: '😊 正面', cls: 'sentiment-positive' },
    neutral: { label: '😐 中性', cls: 'sentiment-neutral' },
    negative: { label: '😠 负面', cls: 'sentiment-negative' },
  };
  const s = sentimentMap[post.sentiment] || sentimentMap.neutral;

  const categoryMap = {
    bug: '🐛 BUG', suggestion: '💡 建议', complaint: '😤 吐槽',
    praise: '👍 好评', question: '❓ 提问', other: '📌 其他',
  };
  const cat = categoryMap[post.ai_category] || '';

  const titleZh = post.title_zh ? `<div class="post-title-zh">${escHtml(post.title_zh)}</div>` : '';
  const catBadge = cat ? `<span class="category-badge">${cat}</span>` : '';

  return `
    <div class="post-card" onclick="openPost('${post.post_id}', '${post.game_code}')">
      <div class="post-card-header">
        <div class="post-title-row">
          <div>
            <div class="post-title">${escHtml(post.title)}</div>
            ${titleZh}
          </div>
        </div>
        <span class="sentiment-badge ${s.cls}">${s.label}</span>
      </div>
      <div class="post-meta">
        <span>👤 ${escHtml(post.author || '匿名')}</span>
        <span>💬 ${post.comment_count || 0}</span>
        <span>👁 ${post.view_count || 0}</span>
        <span>🕐 ${formatTime(post.crawled_at)}</span>
        ${catBadge}
      </div>
    </div>`;
}

// ===== 分页 =====
function renderPagination(pag) {
  const el = document.getElementById('pagination');
  if (!pag || pag.totalPages <= 1) { el.innerHTML = ''; return; }

  let html = '';
  html += `<button class="page-btn" ${pag.page <= 1 ? 'disabled' : ''} onclick="loadPosts(${pag.page - 1})">‹</button>`;

  const start = Math.max(1, pag.page - 2);
  const end = Math.min(pag.totalPages, pag.page + 2);

  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === pag.page ? 'active' : ''}" onclick="loadPosts(${i})">${i}</button>`;
  }

  html += `<button class="page-btn" ${pag.page >= pag.totalPages ? 'disabled' : ''} onclick="loadPosts(${pag.page + 1})">›</button>`;
  el.innerHTML = html;
}

// ===== 帖子详情弹窗 =====
async function openPost(postId, gameCode) {
  const modal = document.getElementById('postModal');
  const body = document.getElementById('modalBody');
  modal.style.display = 'flex';
  body.innerHTML = '<div class="loading-placeholder">⏳ 加载中...</div>';

  try {
    const res = await Api.get(`/api/lounge/posts/${postId}?game=${gameCode}`);
    if (!res.success) {
      body.innerHTML = '<div class="empty-state">加载失败</div>';
      return;
    }

    const post = res.data;
    document.getElementById('modalTitle').textContent = post.title_zh || post.title;

    let html = '';

    // 元信息
    html += `<div class="post-meta" style="margin-bottom:16px;">
      <span>👤 ${escHtml(post.author || '匿名')}</span>
      <span>🕐 ${formatTime(post.post_time || post.crawled_at)}</span>
      <span>💬 ${post.comment_count || 0} 条评论</span>
      <span>👁 ${post.view_count || 0}</span>
      <a href="${post.url}" target="_blank" style="color:#667eea;">🔗 原帖</a>
    </div>`;

    // AI 摘要
    if (post.ai_summary) {
      html += `<div class="detail-section">
        <h4>🤖 AI 摘要</h4>
        <div class="detail-content" style="background:#f0f4ff;border-left:3px solid #667eea;">${escHtml(post.ai_summary)}</div>
      </div>`;
    }

    // 正文（韩文）
    if (post.content) {
      html += `<div class="detail-section">
        <h4>📄 正文（韩文原文）</h4>
        <div class="detail-content">${escHtml(post.content)}</div>
      </div>`;
    }

    // 正文（中文翻译）
    if (post.content_zh) {
      html += `<div class="detail-section">
        <h4>🇨🇳 中文翻译</h4>
        <div class="detail-content detail-content-zh">${escHtml(post.content_zh)}</div>
      </div>`;
    }

    // 图片
    let images = [];
    try { images = JSON.parse(post.images || '[]'); } catch (_) {}
    if (images.length > 0) {
      html += `<div class="detail-section">
        <h4>🖼 图片</h4>
        <div class="detail-images">${images.map(src => `<img src="${src}" loading="lazy" onerror="this.style.display='none'">`).join('')}</div>
      </div>`;
    }

    // 评论
    const comments = post.comments || [];
    html += `<div class="detail-section">
      <h4>💬 评论 (${comments.length})</h4>`;

    if (comments.length === 0) {
      html += '<p style="color:#ccc;font-size:13px;">暂无评论</p>';
    } else {
      for (const c of comments) {
        html += `
          <div class="comment-item">
            <div class="comment-header">
              <span class="comment-author">${escHtml(c.author || '匿名')}</span>
              <span>${formatTime(c.comment_time || c.crawled_at)} ${c.likes > 0 ? `· 👍${c.likes}` : ''}</span>
            </div>
            <div class="comment-text">${escHtml(c.content)}</div>
            ${c.content_zh ? `<div class="comment-text-zh">🇨🇳 ${escHtml(c.content_zh)}</div>` : ''}
          </div>`;
      }
    }
    html += '</div>';

    body.innerHTML = html;

  } catch (e) {
    body.innerHTML = '<div class="empty-state">❌ 网络错误</div>';
  }
}

function closeModal() {
  document.getElementById('postModal').style.display = 'none';
}

// ===== 加载日报 =====
async function loadReport() {
  try {
    const res = await Api.get('/api/lounge/reports?days=1');
    if (!res.success || res.data.length === 0) return;

    const report = res.data[0];

    // 显示日报
    const section = document.getElementById('reportSection');
    section.style.display = 'block';
    document.getElementById('reportContent').textContent = report.ai_summary || '暂无AI分析';

    // 热门话题
    let topics = [];
    try { topics = JSON.parse(report.hot_topics || '[]'); } catch (_) {}
    if (topics.length > 0) {
      document.getElementById('reportTopics').innerHTML =
        topics.map(t => `<span class="topic-tag">${escHtml(t)}</span>`).join('');
    }

    // 更新统计
    document.getElementById('statPosts').textContent = report.total_posts || 0;
    document.getElementById('statComments').textContent = report.total_comments || 0;
    document.getElementById('statPositive').textContent = report.positive_count || 0;
    document.getElementById('statNeutral').textContent = report.neutral_count || 0;
    document.getElementById('statNegative').textContent = report.negative_count || 0;

    // 预警
    let alerts = [];
    try { alerts = JSON.parse(report.alert_keywords || '[]'); } catch (_) {}
    if (alerts.length > 0) {
      const alertSection = document.getElementById('alertSection');
      alertSection.style.display = 'block';
      document.getElementById('alertList').innerHTML = alerts.map(a => `
        <div class="alert-item">
          <span class="alert-keyword">${escHtml(a.label)}</span>
          <span class="alert-title" onclick="openPost('${a.postId}', 'Tree_Of_Savior_Neverland')">${escHtml(a.title)}</span>
        </div>`).join('');
    }

  } catch (e) {
    console.error('加载日报失败:', e);
  }
}

// ===== 手动触发抓取 =====
async function triggerCrawl() {
  const btn = document.getElementById('btnCrawl');
  btn.disabled = true;
  btn.textContent = '⏳ 抓取中...';

  try {
    const res = await Api.post('/api/lounge/crawl', {});
    if (res.success) {
      Toast.success('抓取任务已启动！大约需要2-5分钟，请稍后刷新查看');
      // 每30秒检查一次状态
      const timer = setInterval(async () => {
        await loadStatus();
        const statusRes = await Api.get('/api/lounge/status');
        if (statusRes.success && !statusRes.data.isCrawling) {
          clearInterval(timer);
          btn.disabled = false;
          btn.textContent = '🔄 立即抓取';
          loadPosts();
          loadReport();
          Toast.success('抓取完成！');
        }
      }, 30000);
    } else {
      Toast.error(res.message || '启动失败');
      btn.disabled = false;
      btn.textContent = '🔄 立即抓取';
    }
  } catch (e) {
    Toast.error('网络错误');
    btn.disabled = false;
    btn.textContent = '🔄 立即抓取';
  }
}

// ===== 工具函数 =====
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(t) {
  if (!t) return '--';
  try {
    const d = new Date(t);
    if (isNaN(d.getTime())) return t;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return t;
  }
}

/**
 * 公共前端工具 — API封装/Toast/导航高亮/暗黑模式
 */

// ===== Toast 通知系统 =====
const Toast = {
  container: null,

  init() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },

  show(message, type = 'info', duration = 3000) {
    this.init();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    this.container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(60px)';
      toast.style.transition = 'all 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error', 5000); },
  warning(msg) { this.show(msg, 'warning', 4000); },
  info(msg) { this.show(msg, 'info'); },
};

// ===== API 封装 =====
const Api = {
  async get(url) {
    const res = await fetch(url);
    return res.json();
  },

  async post(url, data = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async put(url, data = {}) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async postWithOperator(url, data = {}) {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    return this.post(url, { ...data, operator: user.name || '' });
  },

  getHeaders() {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    return {
      'Content-Type': 'application/json',
      'X-Operator': encodeURIComponent(user.name || ''),
    };
  },
};

// ===== 导航栏高亮 =====
function highlightNav() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-link').forEach(link => {
    const href = link.getAttribute('href');
    if (href === path || (href !== '/' && path.startsWith(href))) {
      link.classList.add('active');
    }
  });
}

// ===== 统一导航栏 HTML 生成 =====
function renderNav(currentPage) {
  const pages = [
    { path: '/', label: '🚀 DC发布', id: 'home' },
    { path: '/sentiment', label: '📊 舆情监控', id: 'sentiment' },
    { path: '/reports', label: '📋 周报管理', id: 'reports' },
    { path: '/sentiment-history', label: '📚 历史数据', id: 'history' },
    { path: '/admin', label: '🔐 权限管理', id: 'admin' },
  ];
  return pages.map(p =>
    `<a href="${p.path}" class="nav-link${currentPage === p.id ? ' active' : ''}">${p.label}</a>`
  ).join('');
}

// ===== 暗黑模式 =====
const DarkMode = {
  init() {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  },

  toggle() {
    const current = document.documentElement.getAttribute('data-theme');
    if (current === 'dark') {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    }
  },

  isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  },
};

// ===== 登录态检查 =====
function checkAuth() {
  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (!user || !user.name) {
    window.location.href = '/';
    return null;
  }
  return user;
}

function getUser() {
  return JSON.parse(localStorage.getItem('user') || 'null');
}

function isAdminUser() {
  const user = getUser();
  return user && user.role === 'admin';
}

// ===== 导航栏权限过滤 =====
// 隐藏所有 .admin-only 元素（普通用户不可见）
function applyNavPermissions() {
  if (isAdminUser()) return; // 管理员不过滤
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = 'none';
  });
}

// ===== 公共工具函数 =====
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatTimestamp(timestamp) {
  if (!timestamp) return '未知';
  if (typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
    const [datePart, timePart] = timestamp.split(' ');
    const [year, month, day] = datePart.split('-');
    return `${year}年${month}月${day}日 ${timePart}`;
  }
  let date;
  if (typeof timestamp === 'string' && !timestamp.includes('T')) {
    date = new Date(timestamp.replace(' ', 'T') + '+08:00');
  } else {
    date = new Date(timestamp);
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}年${m}月${d}日 ${h}:${mi}:${s}`;
}

// ===== 求助 / 反馈浮动按钮 =====
const FeedbackBtn = {
  init() {
    // 不在登录页显示
    if (!getUser()) return;
    if (document.getElementById('feedback-fab')) return;

    // 浮动按钮
    const fab = document.createElement('button');
    fab.id = 'feedback-fab';
    fab.className = 'feedback-fab';
    fab.title = '求助 / 反馈';
    fab.textContent = '💬';
    fab.onclick = () => this.openModal();
    document.body.appendChild(fab);

    // 弹窗蒙层
    const overlay = document.createElement('div');
    overlay.id = 'feedback-overlay';
    overlay.className = 'feedback-overlay';
    overlay.innerHTML = `
      <div class="feedback-modal">
        <div class="feedback-modal-header">
          <h3>💬 求助 / 反馈</h3>
          <button class="feedback-close" onclick="FeedbackBtn.closeModal()">&times;</button>
        </div>
        <div class="feedback-modal-body">
          <input id="feedbackTitle" class="feedback-input" placeholder="问题标题（必填）" maxlength="100">
          <textarea id="feedbackContent" class="feedback-textarea" placeholder="详细描述你遇到的问题或建议…" maxlength="2000"></textarea>
          <button class="btn btn-primary feedback-submit" onclick="FeedbackBtn.submit()">提交给管理员</button>
        </div>
      </div>
    `;
    overlay.onclick = (e) => { if (e.target === overlay) this.closeModal(); };
    document.body.appendChild(overlay);
  },

  openModal() {
    document.getElementById('feedback-overlay').classList.add('active');
  },
  closeModal() {
    document.getElementById('feedback-overlay').classList.remove('active');
  },

  async submit() {
    const title = document.getElementById('feedbackTitle').value.trim();
    const content = document.getElementById('feedbackContent').value.trim();
    if (!title) { Toast.warning('请填写标题'); return; }
    if (!content) { Toast.warning('请填写内容'); return; }
    try {
      const user = getUser();
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Operator': encodeURIComponent(user?.name || ''),
        },
        body: JSON.stringify({ title, content }),
      });
      const data = await res.json();
      if (data.ok) {
        Toast.success('反馈已发送给管理员！');
        document.getElementById('feedbackTitle').value = '';
        document.getElementById('feedbackContent').value = '';
        this.closeModal();
      } else {
        Toast.error(data.error || '提交失败');
      }
    } catch (e) {
      Toast.error('提交失败: ' + e.message);
    }
  },
};

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  DarkMode.init();
  highlightNav();
  applyNavPermissions();
  FeedbackBtn.init();
});

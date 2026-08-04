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

// ===== API 封装（自动带 Cookie 凭证）=====
const Api = {
  async get(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    return res.json();
  },

  async post(url, data = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'same-origin',
    });
    return res.json();
  },

  async put(url, data = {}) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'same-origin',
    });
    return res.json();
  },

  getHeaders() {
    return {
      'Content-Type': 'application/json',
    };
  },
};

// ===== 导航栏高亮（已迁移到侧边栏，保留兼容）=====
function highlightNav() {
  // 侧边栏已在 renderNav 中处理高亮
}

// ===== SVG 图标定义（1.6px 描边线性图标） =====
const SVG_ICONS = {
  sentiment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3v18h18M8 17V9M13 17V5M18 17v-6"/></svg>',
  reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 2h6v4H9zM9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  insights: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  publish: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
  assistant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  terminology: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 5v14c0 1.7-4 3-9 3s-9-1.3-9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
};

// ===== 侧边栏导航渲染（黑白未来感 · 图标停靠栏 + 悬停展开） =====
function renderNav() {
  const path = window.location.pathname;
  const role = getUserRole();
  const roleLevel = ROLE_LEVEL[role] || 0;
  const user = getUser();
  const userName = user && user.name ? user.name.toUpperCase() : 'USER';
  const userInitial = userName.charAt(0);
  const roleLabel = ROLE_LABEL_MAP[role] || role;
  // 去掉 roleLabel 前面的 emoji
  const roleText = roleLabel.replace(/^[^\u4e00-\u9fa5a-zA-Z]+/, '');
  
  const groups = [
    { label: '舆情监控', items: [
      { path: '/sentiment', label: '舆情日报', icon: SVG_ICONS.sentiment, match: p => p.startsWith('/sentiment') && !p.includes('history'), minRole: 'viewer' },
      { path: '/reports', label: '周报管理', icon: SVG_ICONS.reports, match: p => p.startsWith('/reports'), minRole: 'operator' },
      { path: '/sentiment-history', label: '历史数据', icon: SVG_ICONS.history, match: p => p.includes('sentiment-history'), minRole: 'operator' },
      { path: '/insights', label: '玩家洞察', icon: SVG_ICONS.insights, match: p => p === '/insights', minRole: 'super_admin', superOnly: true },
    ]},
    { label: '内容管理', items: [
      { path: '/', label: 'DC发布', icon: SVG_ICONS.publish, match: p => p === '/', minRole: 'operator' },
      { path: '/post-assistant', label: '贴文助手', icon: SVG_ICONS.assistant, match: p => p.startsWith('/post-assistant'), minRole: 'operator', permKey: 'postAssistant' },
      { path: '/terminology', label: '术语校对', icon: SVG_ICONS.terminology, match: p => p.startsWith('/terminology'), minRole: 'viewer' },
    ]},
    { label: '权限管理', items: [
      { path: '/admin', label: '权限管理', icon: SVG_ICONS.admin, match: p => p === '/admin' && !location.hash.includes('database'), minRole: 'admin' },
      { path: '/admin#database', label: '数据库管理', icon: SVG_ICONS.database, match: p => p === '/admin' && location.hash.includes('database'), minRole: 'admin' },
    ]},
  ];
  
  let navHtml = '';
  groups.forEach((group, gi) => {
    const visibleItems = group.items.filter(p => {
      if (p.superOnly && role !== 'super_admin') return false;
      return true;
    });
    if (!visibleItems.length) return;
    navHtml += `<div class="side-sec">${group.label}</div>`;
    for (const p of visibleItems) {
      const minLevel = ROLE_LEVEL[p.minRole] || 0;
      const hasRoleAccess = roleLevel >= minLevel;
      const hasPerm = hasRoleAccess && _hasUserPerm(p.permKey);
      const isActive = p.match(path);
      if (hasRoleAccess && hasPerm) {
        navHtml += `<a href="${p.path}" class="side-item${isActive ? ' on' : ''}">${p.icon}<span class="st">${p.label}</span></a>`;
      } else if (hasRoleAccess && !hasPerm) {
        navHtml += `<span class="side-item sidebar-disabled" title="管理员已关闭此功能的权限" onclick="Toast.warning('管理员已关闭你的贴文助手权限，请联系管理员开通')">${p.icon}<span class="st">${p.label}</span></span>`;
      } else {
        navHtml += `<span class="side-item sidebar-disabled" title="权限不足">${p.icon}<span class="st">${p.label}</span></span>`;
      }
    }
  });
  
  // 底部操作区
  const darkBtnText = '暗黑模式';
  const isDark = DarkMode.isDark();
  const footerHtml = `
    <a class="side-item${isDark ? ' on-dark' : ''}" id="sideDarkToggle" onclick="DarkMode.toggle(); renderNav();">${SVG_ICONS.moon}<span class="st">${darkBtnText}</span><span class="side-switch"><i></i></span></a>
    <a class="side-item danger" href="/api/auth/logout">${SVG_ICONS.logout}<span class="st">退出登录</span></a>
  `;
  
  const sidebarHtml = `
    <div class="side-head">
      <div class="logo-mark">M2</div>
      <div class="st ht"><div class="t1">M2G 运营后台</div><div class="t2">OVERSEAS COMMUNITY</div></div>
    </div>
    <div class="side-user">
      <div class="u-ava">${userInitial}</div>
      <div class="st"><div class="u-name">${escapeHtml(userName)}</div><span class="u-role">${roleText}</span></div>
    </div>
    <div class="side-scroll">${navHtml}</div>
    <div class="side-pulse"></div>
    <div class="side-foot">${footerHtml}</div>
  `;
  
  // 注入侧边栏到 body
  let sidebar = document.getElementById('sidebarNav');
  if (!sidebar) {
    sidebar = document.createElement('aside');
    sidebar.id = 'sidebarNav';
    sidebar.className = 'sidebar';
    document.body.prepend(sidebar);
  }
  sidebar.innerHTML = sidebarHtml;
  
  // 首次进入自动展开 1.8s（只演一次）
  if (!sessionStorage.getItem('sidebar_peeked')) {
    sessionStorage.setItem('sidebar_peeked', '1');
    sidebar.classList.add('peek');
    setTimeout(() => sidebar.classList.remove('peek'), 1800);
  }
  
  // 隐藏旧的 header-nav（如果存在）
  const oldNav = document.getElementById('mainNav');
  if (oldNav) oldNav.style.display = 'none';
}

// ===== 暗黑模式 =====
const DarkMode = {
  init() {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
  },

  toggle() {
    const current = document.documentElement.getAttribute('data-theme');
    if (current === 'dark') {
      document.documentElement.removeAttribute('data-theme');
      document.body.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    }
    // 动态更新切换按钮文案
    DarkMode.updateToggleBtn();
  },

  isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  },

  updateToggleBtn() {
    const btn = document.querySelector('.nav-dark-toggle');
    if (btn) {
      btn.textContent = DarkMode.isDark() ? '☀️ 切换白昼模式' : '🌙 切换暗黑模式';
    }
  },
};

// ===== 登录态检查（通过服务端 JWT Cookie 验证）=====
function checkAuth() {
  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (!user || !user.name) {
    window.location.href = '/login';
    return null;
  }
  return user;
}

function getUser() {
  return JSON.parse(localStorage.getItem('user') || 'null');
}

// ===== 角色层次 =====
const ROLE_LEVEL = { pending: 0, viewer: 1, operator: 2, admin: 3, super_admin: 4 };
const ROLE_LABEL_MAP = {
  pending: '⏳ 待审批', viewer: '👁️ 查看者', operator: '⚙️ 运营员',
  admin: '👑 管理员', super_admin: '🌟 超级管理员'
};

function getUserRole() {
  const user = getUser();
  return user && user.role ? user.role : 'viewer';
}

function getUserPerms() {
  const user = getUser();
  return user && user.perms ? user.perms : {};
}

// 检查细粒度权限（如 postAssistant）
function _hasUserPerm(permKey) {
  if (!permKey) return true;
  const role = getUserRole();
  // admin/super_admin 默认全权限
  if (role === 'admin' || role === 'super_admin') return true;
  const perms = getUserPerms();
  if (permKey === 'postAssistant') return perms.postAssistant !== false;
  return !!perms[permKey];
}

function getRoleLevel() {
  return ROLE_LEVEL[getUserRole()] || 0;
}

function isAdminUser() {
  const role = getUserRole();
  return role === 'admin' || role === 'super_admin';
}

function isSuperAdmin() {
  return getUserRole() === 'super_admin';
}

function isOperatorOrAbove() {
  return getRoleLevel() >= ROLE_LEVEL.operator;
}

// ===== 导航栏权限过滤 =====

// ===== 顶部 banner 注入用户名和角色 =====
function renderUserInfo() {
  const user = getUser();
  if (!user || !user.name) return;
  const headerInner = document.querySelector('.app-header-inner');
  if (!headerInner) return;
  const role = getUserRole();
  const roleLabel = ROLE_LABEL_MAP[role] || role;
  const roleClass = 'hui-role-' + role;
  const avatarHtml = user.picture
    ? `<span class="hui-avatar"><img src="${escapeHtml(user.picture)}" alt="" /></span>`
    : `<span class="hui-avatar">👤</span>`;
  const infoHtml = `
    <div class="header-user-info">
      ${avatarHtml}
      <span class="hui-name">${escapeHtml(user.name)}</span>
      <span class="hui-role ${roleClass}">${roleLabel}</span>
    </div>`;
  // 插入到 header-inner 右侧（不再依赖 .header-nav）
  const headerLeft = headerInner.querySelector('.header-left');
  if (headerLeft) {
    headerLeft.insertAdjacentHTML('afterend', infoHtml);
  } else {
    headerInner.insertAdjacentHTML('beforeend', infoHtml);
  }
}
// pending 用户隐藏所有操作按钮
// 非 admin 隐藏 admin-only
// 非 operator 隐藏 operator-only
// 非 super_admin 隐藏 super-admin-only
function applyNavPermissions() {
  const role = getUserRole();
  const roleLevel = ROLE_LEVEL[role] || 0;
  
  // pending 用户：显示待审批遮罩，隐藏所有内容
  if (role === 'pending') {
    showPendingOverlay();
    return;
  }
  
  if (!isAdminUser()) {
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = 'none';
    });
  }
  if (roleLevel < ROLE_LEVEL.operator) {
    document.querySelectorAll('.operator-only').forEach(el => {
      el.style.display = 'none';
    });
  }
  if (role !== 'super_admin') {
    document.querySelectorAll('.super-admin-only').forEach(el => {
      el.style.display = 'none';
    });
  }
}

// 对 operator 只读页面隐藏写入按钮
function applyReadOnlyMode() {
  if (isAdminUser()) return; // 管理员不受限
  if (getRoleLevel() < ROLE_LEVEL.operator) return; // viewer 根本看不到这些页面
  // operator 在周报/历史数据页面隐藏“生成”“保存”“上传”等写入按钮
  document.querySelectorAll('.admin-write-only').forEach(el => {
    el.style.display = 'none';
  });
}

// ===== Pending 用户待审批遮罩 =====
function showPendingOverlay() {
  // 隐藏主内容
  const mainContent = document.querySelector('.container') || document.querySelector('#mainApp') || document.querySelector('main');
  if (mainContent) mainContent.style.display = 'none';
  
  // 创建全屏遮罩
  const overlay = document.createElement('div');
  overlay.id = 'pending-overlay';
  overlay.innerHTML = `
    <div class="pending-card">
      <div class="pending-icon">⏳</div>
      <h1 class="pending-title">账号待审批</h1>
      <p class="pending-desc">需要前往阿里钉@阿饱 开通相关权限方可进入</p>
      <div class="pending-actions">
        <button class="btn btn-secondary" onclick="window.location.href='/api/auth/logout'">🚪 退出登录</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
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
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content }),
        credentials: 'same-origin',
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

// ===== 阿饱提示 帮助弹窗系统 =====
const AbaoTip = {
  tips: {},  // 各页面的帮助内容

  // 注册页面帮助内容
  register(pageKey, htmlContent) {
    this.tips[pageKey] = htmlContent;
  },

  // 显示帮助弹窗
  show(pageKey) {
    const content = this.tips[pageKey];
    if (!content) {
      Toast.info('该页面暂无操作提示');
      return;
    }
    // 创建遮罩 + 弹窗
    const overlay = document.createElement('div');
    overlay.className = 'abao-help-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="abao-help-modal">
        <div class="abao-help-header">
          <h3>💡 阿饱提示</h3>
          <button class="abao-help-close" onclick="this.closest('.abao-help-overlay').remove()">✕</button>
        </div>
        <div class="abao-help-body">${content}</div>
      </div>`;
    document.body.appendChild(overlay);
    // ESC 关闭
    const escHandler = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);
  },

  // 在 header 注入帮助按钮（只保留💡图标，贴在大标题旁边）
  injectButton(pageKey) {
    const h1 = document.querySelector('.header-left h1');
    if (!h1) return;
    if (h1.querySelector('.abao-help-btn')) return; // 已存在
    const btn = document.createElement('button');
    btn.className = 'abao-help-btn';
    btn.innerHTML = '💡';
    btn.title = '阿饱提示';
    btn.onclick = () => this.show(pageKey);
    h1.insertAdjacentElement('afterend', btn);
  },
};

// 注册各页面帮助内容
AbaoTip.register('post-assistant', `
  <h4>🤖 左侧：阿里 AI Studio（免费）</h4>
  <ul>
    <li>这是公司账号的 <strong>AI Studio 模型</strong>，已经训练好了，专门用于<strong>贴文制作</strong></li>
    <li>你可以发送文案给它，也可以<strong>只发一张图片</strong>让它帮你写配文</li>
    <li>不花钱，随便用，想怎么用怎么用</li>
  </ul>
  <div class="abao-tip-highlight">
    💡 小提示：左侧 AI 可以帮你润色文案、翻译、生成贴文内容，是日常工作的主要工具。
  </div>
  <h4>💰 右侧：付费 AI（翻译 & 校对）</h4>
  <ul>
    <li>右侧的翻译和校对功能使用的是<strong>阿饱自费的 AI</strong></li>
    <li>每人每天 <strong>15 次</strong>额度，请合理使用，不要浪费</li>
    <li>翻译结果和校对结果会分别显示在下方 Tab 中，不会互相覆盖</li>
  </ul>
`);

AbaoTip.register('sentiment', `
  <h4>📌 今日快报</h4>
  <ul>
    <li>顶部 4 张卡片显示今日 Twitter/Discord 发言数、风险等级、整体情绪</li>
    <li>热门话题展示 AI 分析的玩家讨论热点，每个话题有原声样本和原帖链接</li>
    <li>点击<strong>“📝 玩家发言原声”</strong>可展开查看玩家原始发言</li>
  </ul>
  <h4>📈 七日舆情趋势</h4>
  <ul>
    <li>统计卡片显示 7 日总量、日均发言、趋势变化、最热话题</li>
    <li>柱状图显示每日发言量对比，情绪变化条显示每日正负面情绪比例</li>
  </ul>
  <h4>🔥 七日热门话题</h4>
  <ul>
    <li>每个话题卡片包含：热度评分、讨论数、情绪判断、玩家原声、原帖链接</li>
    <li>点击“原帖↗”可跳转到 Twitter/Discord 原始帖子</li>
  </ul>
  <div class="abao-tip-highlight">
    💡 数据每 8:30 自动采集 + AI 分析，也可手动点击“启动抓取”和“AI分析”按钮。
  </div>
`);

AbaoTip.register('admin', `
  <h4>👥 用户管理</h4>
  <ul>
    <li>查看和修改用户角色：pending → viewer → operator → admin → super_admin</li>
    <li>角色越高权限越大，super_admin 拥有所有权限</li>
  </ul>
  <h4>🔑 Token 管理</h4>
  <ul>
    <li>查看各服务 Token 状态，<strong>仅超级管理员</strong>可更新 Token</li>
  </ul>
  <h4>💬 意见反馈</h4>
  <ul>
    <li>仅超级管理员可见，查看用户提交的反馈和建议</li>
  </ul>
`);

AbaoTip.register('terminology', `
  <h4>📚 术语库</h4>
  <ul>
    <li>管理游戏术语翻译，支持搜索、新增、编辑、删除</li>
    <li>术语库用于贴文助手的自动校对功能</li>
    <li>每条术语包含：原文、译文、分类、备注</li>
  </ul>
`);

AbaoTip.register('home', `
  <h4>🏠 发布系统</h4>
  <ul>
    <li>DC 发布系统用于向 Discord 频道发送消息和管理公告</li>
    <li>支持文字+图片发布，可选择不同频道</li>
  </ul>
`);

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  DarkMode.init();
  
  // 同步服务器角色到 localStorage（确保 pending 用户被正确识别）
  try {
    const resp = await fetch('/api/auth/verify', { credentials: 'same-origin' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.valid && data.user) {
        localStorage.setItem('user', JSON.stringify({
          name: data.user.username,
          role: data.user.role,
          email: data.user.email,
          picture: data.user.picture,
          perms: data.permissions || {},
        }));
      }
    }
  } catch (_) {}
  
  renderNav();           // 渲染侧边栏导航
  renderUserInfo();       // 在顶部 banner 注入用户名和角色
  applyNavPermissions(); // 非管理员隐藏 admin-only
  applyReadOnlyMode();   // operator 隐藏写入按钮
  FeedbackBtn.init();
  
  // 注入"阿饱提示"帮助按钮
  const path = window.location.pathname;
  let pageKey = 'home';
  if (path.includes('post-assistant')) pageKey = 'post-assistant';
  else if (path.includes('sentiment')) pageKey = 'sentiment';
  else if (path.includes('admin')) pageKey = 'admin';
  else if (path.includes('terminology')) pageKey = 'terminology';
  AbaoTip.injectButton(pageKey);
});

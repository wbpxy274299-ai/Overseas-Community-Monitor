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

// ===== 居中弹窗（无权限提醒等重要提示用，比角落 Toast 更显眼）=====
// 样式严格遵循 M2G 设计规范：零渐变/零 emoji/颜色令牌/白卡签名圆角 20-20-20-4/btn-solid 带箭头
const AlertModal = {
  _styleInjected: false,

  _injectStyle() {
    if (this._styleInjected) return;
    this._styleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .alert-modal-mask {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); /* 遮罩固定深色，同 components.css .modal-overlay */
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; animation: alertModalFadeIn 0.2s ease;
      }
      @keyframes alertModalFadeIn { from { opacity: 0; } to { opacity: 1; } }
      .alert-modal-card {
        background: var(--panel, #FFFFFF);
        color: var(--ink, #0B0B0C);
        border: 1px solid var(--line, #D8DADD);
        border-radius: 20px 20px 20px 4px; /* 白卡签名圆角（左下小圆角） */
        padding: 32px 28px 26px;
        max-width: 420px; width: 90%;
        text-align: center;
        box-shadow: var(--shadow, 0 30px 60px rgba(11,11,12,.08));
        animation: alertModalUp 0.25s ease; /* 上移14px+淡入，禁弹跳 */
      }
      @keyframes alertModalUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
      .alert-modal-micro {
        font-size: 11px; letter-spacing: .38em; text-transform: uppercase;
        font-weight: 500; color: var(--mut, #84868B); margin-bottom: 14px;
      }
      .alert-modal-icon {
        width: 44px; height: 44px; margin: 0 auto;
        display: flex; align-items: center; justify-content: center;
        color: var(--warn, #C9973B); /* 警示类提醒用语义黄 */
      }
      .alert-modal-icon svg { width: 40px; height: 40px; }
      .alert-modal-title { font-size: 17px; font-weight: 700; margin: 12px 0 8px; }
      .alert-modal-msg {
        font-size: 13px; line-height: 1.6; color: var(--mut, #84868B);
        margin-bottom: 22px; word-break: break-word;
      }
      /* btn-solid 规范：--ink 底 / --bg 字 / 圆角10px / 必带箭头，悬停箭头右移4px */
      .alert-modal-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 12px 22px; border: none; border-radius: 10px; cursor: pointer;
        background: var(--ink, #0B0B0C); color: var(--bg, #ECEDEF);
        font-size: 13px; font-weight: 600; font-family: inherit;
      }
      .alert-modal-btn .ar { transition: transform 0.2s ease; }
      .alert-modal-btn:hover .ar { transform: translateX(4px); }
    `;
    document.head.appendChild(style);
  },

  /** 弹居中对话框：线性图标 + micro 英文标签 + 标题 + 正文 + 知道了按钮 */
  show(iconSvg, microLabel, title, message) {
    this._injectStyle();
    const mask = document.createElement('div');
    mask.className = 'alert-modal-mask';
    mask.innerHTML = `
      <div class="alert-modal-card">
        <div class="alert-modal-micro">${microLabel}</div>
        <div class="alert-modal-icon">${iconSvg}</div>
        <div class="alert-modal-title">${title}</div>
        <div class="alert-modal-msg">${message}</div>
        <button class="alert-modal-btn" type="button">知道了 <span class="ar">→</span></button>
      </div>`;
    const close = () => mask.remove();
    mask.querySelector('.alert-modal-btn').onclick = close;
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    document.body.appendChild(mask);
  },

  /** 无权限专用弹窗（锁形线性图标，1.6px 描边 currentColor） */
  noPermission(message) {
    const lockSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.4"/></svg>`;
    this.show(lockSvg, 'Access Denied', '无权限访问', message);
  },
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
        navHtml += `<span class="side-item sidebar-disabled" title="管理员已关闭此功能的权限" onclick="AlertModal.noPermission('管理员已关闭你的贴文助手权限，请联系管理员开通')">${p.icon}<span class="st">${p.label}</span></span>`;
      } else {
        // ★ 角色不足：置灰 + 点击弹无权限提醒（告知所需角色，不静默无反应）
        const needLabel = (ROLE_LABEL_MAP[p.minRole] || p.minRole).replace(/^[^\u4e00-\u9fa5a-zA-Z]+/, '');
        navHtml += `<span class="side-item sidebar-disabled" title="权限不足，需${needLabel}及以上" onclick="AlertModal.noPermission('你没有权限访问「${p.label}」，需要 ${needLabel} 及以上角色，请联系管理员开通')">${p.icon}<span class="st">${p.label}</span></span>`;
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
  
  // 🚫 Pending 用户：显示遮罩（双重保护，配合后端 403）
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
  // 🚫 Pending 用户遮罩：在现有页面上覆盖遮罩（提升用户体验）
  
  // 1. 创建全屏遮罩层
  const overlay = document.createElement('div');
  overlay.id = 'pending-overlay';
  overlay.innerHTML = `
    <style>
      #pending-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(255, 255, 255, 0.98);
        backdrop-filter: blur(10px);
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.3s ease-in;
      }
      
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      
      .pending-card {
        text-align: center;
        padding: 40px;
        max-width: 400px;
      }
      
      .pending-card h1 {
        font-size: 72px;
        color: #6c757d;
        margin: 0;
        font-weight: 700;
      }
      
      .pending-card p {
        font-size: 18px;
        color: #333;
        margin: 16px 0;
        font-weight: 600;
      }
      
      .pending-card .desc {
        font-size: 14px;
        color: #666;
        line-height: 1.6;
        margin-bottom: 24px;
      }
      
      .pending-card .warning {
        background: #fff3cd;
        border: 1px solid #ffc107;
        border-radius: 8px;
        padding: 12px 16px;
        font-size: 13px;
        color: #856404;
      }
    </style>
    
    <div class="pending-card">
      <h1>403</h1>
      <p>账号待审批 · 暂时无法访问</p>
      <p class="desc">
        您的账号尚未通过管理员审批，系统已限制访问权限。
        <br><br>
        <strong style="color: #333;">👉 请前往阿里钉，将您的 <span style="color: #d93025; background: #fce8e6; padding: 2px 6px; border-radius: 4px;">Gmail 地址</span> 发送给 <span style="color: #1a73e8; background: #e8f0fe; padding: 2px 6px; border-radius: 4px;">阿饱同学</span> 申请开通权限。</strong>
      </p>
      <div class="warning">⚠️ 提交后请等待管理员审批完成，通常会在 24 小时内处理。</div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  // 2. 禁用页面交互（防止用户点击按钮或链接）
  overlay.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  });
  
  // 3. 禁用键盘操作
  document.addEventListener('keydown', function(e) {
    if (overlay.style.display !== 'none') {
      e.preventDefault();
      return false;
    }
  }, true);
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

// ===== 浮动反馈组件（V43） =====
const FeedbackBtn = {
  init() {
    if (!getUser()) return;
    if (document.getElementById('fbFab')) return;

    // FAB 按钮
    const fab = document.createElement('button');
    fab.id = 'fbFab';
    fab.className = 'fb-fab';
    fab.title = '反馈';
    fab.setAttribute('aria-label', '反馈');
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>';
    fab.onclick = () => this.toggle();
    document.body.appendChild(fab);

    // 浮动面板
    const win = document.createElement('div');
    win.className = 'fb-win';
    win.id = 'fbWin';
    win.innerHTML = `
      <div class="fh">
        <span class="t">💬 反馈</span>
        <span class="fb-sub">Feedback</span>
        <button class="x" onclick="FeedbackBtn.toggle()">&times;</button>
      </div>
      <div class="fb-body">
        <textarea id="fbText" placeholder="详细描述你遇到的问题或建议…"></textarea>
        <input id="fbName" placeholder="你的称呼（必填）">
        <div class="fb-foot">
          <span class="fb-hint">直接发送给管理员</span>
          <button class="fb-submit" onclick="FeedbackBtn.submit()">提交给管理员 →</button>
        </div>
        <div id="fbOk" style="display:none;margin-top:12px;color:#4C9E6E;font-size:12px;font-weight:600">已收到，感谢反馈！</div>
      </div>
    `;
    document.body.appendChild(win);
  },

  toggle() {
    document.getElementById('fbWin').classList.toggle('open');
  },

  async submit() {
    const content = document.getElementById('fbText').value.trim();
    const name = document.getElementById('fbName').value.trim();
    if (!content) { Toast.warning('请先填写反馈内容'); return; }
    if (!name) { Toast.warning('请填写你的称呼（必填）'); return; }

    const okEl = document.getElementById('fbOk');
    const btn = document.querySelector('.fb-submit');
    btn.disabled = true;
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title: '玩家反馈 · ' + name, content: content })
      });
      const data = await res.json();
      if (data.ok) {
        okEl.style.display = 'block';
        document.getElementById('fbText').value = '';
        document.getElementById('fbName').value = '';
        setTimeout(() => { okEl.style.display = 'none'; this.toggle(); }, 1400);
      } else {
        Toast.error(data.error || '提交失败，请稍后重试');
      }
    } catch (e) {
      Toast.error('提交失败：' + e.message);
    } finally {
      btn.disabled = false;
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
  
  // 🚫 紧急检查：pending 用户立即拦截（在渲染任何内容之前）
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
        
        // 🔴 如果 pending，立即显示锁定页面，不继续渲染
        if (data.user.role === 'pending') {
          showPendingOverlay();
          return; // ← 中止后续所有初始化
        }
      }
    } else {
      // 未登录或登录过期
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
  } catch (_) {}
  
  // ★ 无权限重定向提醒：后端拦截越权访问后会跳到 /sentiment?noperm=页面名，
  //   这里弹提醒并清掉 URL 参数（刷新不会重复弹）
  try {
    const noperm = new URLSearchParams(window.location.search).get('noperm');
    if (noperm) {
      AlertModal.noPermission(`你没有权限访问「${decodeURIComponent(noperm)}」，请联系管理员开通`);
      history.replaceState(null, '', window.location.pathname);
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

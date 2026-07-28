/* ========================================
   游戏术语校对工具 - 数据加载与管理
   数据从 data/terms.json 异步加载
   ======================================== */

let TERMS = [];
let ALL_INDEX = {};
let VERSION_INFO = null;

/**
 * 建立搜索索引
 */
function addIndex(text, idx, isCn) {
  if (!text || text.length < 2) return;
  if (isCn && text.length > 10) return;
  if (/[<！？。，]/.test(text)) return;
  const n = normalize(text);
  if (!ALL_INDEX[n]) ALL_INDEX[n] = new Set();
  ALL_INDEX[n].add(idx);
}

/**
 * 从 terms.json 加载数据并建立索引
 */
async function loadData() {
  showLoading('正在加载术语数据...');

  try {
    const [termsResp, versionResp] = await Promise.all([
      fetch('data/terms.json'),
      fetch('data/version.json')
    ]);
    
    if (!termsResp.ok) throw new Error('无法加载 terms.json，请确认文件存在');
    TERMS = await termsResp.json();
    
    if (versionResp.ok) {
      VERSION_INFO = await versionResp.json();
    }
  } catch (e) {
    showLoading('数据加载失败: ' + e.message);
    return;
  }

  rebuildIndex();
  hideLoading();
  updateStatsBar();
  displayVersionInfo();
}

/**
 * 显示版本信息
 */
function displayVersionInfo() {
  const el = document.getElementById('ver-date');
  if (el && VERSION_INFO) {
    const ver = VERSION_INFO.version || '';
    const count = VERSION_INFO.count ? ' ' + VERSION_INFO.count.toLocaleString() + '\u6761' : '';
    el.textContent = '\u5168\u91CF' + ver + count;
  }
}

/**
 * 重建索引（用于数据更新后）
 */
function rebuildIndex() {
  ALL_INDEX = {};
  for (let i = 0; i < TERMS.length; i++) {
    const t = TERMS[i];
    addIndex(t[0], i, true);
    for (let li = 0; li < LANG_KEYS.length; li++) {
      const text = t[li + 1];
      if (text) text.split(' | ').forEach(p => addIndex(p.trim(), i, false));
    }
  }
}

/**
 * 显示加载状态
 */
function showLoading(msg) {
  const el = document.getElementById('loading');
  el.style.display = 'block';
  el.querySelector('.progress').textContent = msg;
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
}

/**
 * 隐藏加载状态，显示主界面
 */
function hideLoading() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

/**
 * 更新统计栏
 */
function updateStatsBar() {
  const el = document.getElementById('stats-bar');
  if (el) el.textContent = '共 ' + TERMS.length.toLocaleString() + ' 条术语';
}

/* ========================================
   游戏术语校对工具 - 术语表更新模块
   支持单语言更新和批量导入，更新后可下载新 JSON
   ======================================== */

let updateMode = 'batch';
let updateLang = 'jp';
let updatedTerms = null;

/**
 * 打开更新弹窗
 */
function openUpdateModal() {
  document.getElementById('update-modal').classList.add('show');
  resetUpdateStatus();
}

/**
 * 关闭更新弹窗
 */
function closeUpdateModal() {
  document.getElementById('update-modal').classList.remove('show');
}

/**
 * 重置更新状态
 */
function resetUpdateStatus() {
  document.getElementById('update-status').className = 'status';
  document.getElementById('update-status').textContent = '';
  document.getElementById('update-stats').style.display = 'none';
  document.getElementById('update-download-btn').style.display = 'none';
  updatedTerms = null;
  document.getElementById('batch-file-list').innerHTML = '';
}

/**
 * 设置状态提示
 */
function setUpdateStatus(type, msg) {
  const el = document.getElementById('update-status');
  el.className = 'status ' + type;
  el.textContent = msg;
}

/**
 * 设置统计信息
 */
function setUpdateStats(msg) {
  const el = document.getElementById('update-stats');
  el.style.display = 'block';
  el.innerHTML = msg;
}

/**
 * 初始化更新模块的事件绑定
 */
function initUpdateModule() {
  // 模式切换
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateMode = btn.dataset.mode;
      document.getElementById('batch-mode').style.display = updateMode === 'batch' ? 'block' : 'none';
      document.getElementById('single-mode').style.display = updateMode === 'single' ? 'block' : 'none';
    });
  });

  // 语言选择
  document.querySelectorAll('#update-lang-select button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#update-lang-select button').forEach(b => {
        b.style.borderColor = '#e0e0e0';
        b.style.background = '#fff';
        b.style.color = '#333';
        b.style.fontWeight = 'normal';
      });
      btn.style.borderColor = '#764ba2';
      btn.style.background = '#f0e6ff';
      btn.style.color = '#764ba2';
      btn.style.fontWeight = '600';
      updateLang = btn.dataset.lang;
    });
  });

  // 拖拽上传
  setupDrop('batch-drop-zone', 'batch-file-input', handleBatchFiles);
  setupDrop('update-drop-zone', 'update-file-input', f => handleUpdateFile(f[0]));
}

/**
 * 通用拖拽/点击上传绑定
 */
function setupDrop(zoneId, inputId, handler) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handler(e.dataTransfer.files);
  });
  input.addEventListener('change', e => {
    if (e.target.files.length) handler(e.target.files);
  });
}

/**
 * 批量导入多个 Excel
 */
async function handleBatchFiles(files) {
  const fileList = document.getElementById('batch-file-list');
  fileList.innerHTML = '';
  setUpdateStatus('loading', '\u23F3 正在读取文件...');

  const validFiles = [];
  for (const file of files) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) continue;
    const lang = detectLang(file.name);
    if (!lang) {
      fileList.innerHTML += '<div class="file-item">\u26A0\uFE0F 无法识别: <b>' + esc(file.name) + '</b></div>';
      continue;
    }
    validFiles.push({ file, lang });
    fileList.innerHTML += '<div class="file-item">\u2705 '
      + LANG_EMOJI[lang] + ' ' + LANG_NAMES[lang]
      + ': <b>' + esc(file.name) + '</b></div>';
  }

  if (validFiles.length === 0) {
    setUpdateStatus('error', '\u274C 没有找到可识别的 Excel 文件');
    return;
  }

  setUpdateStatus('loading', '\u23F3 解析 ' + validFiles.length + ' 个文件...');

  try {
    const merged = {};
    for (const { file, lang } of validFiles) {
      const rows = await readExcel(file);
      for (const row of rows) {
        const cn = String(row[0] || '').trim();
        const trans = String(row[1] || '').trim();
        const cat = String(row[3] || '').trim();
        const key = String(row[4] || '').trim();
        const note = String(row[6] || '').trim();

        if (!cn || cn.length > 10 || cat === '剧情' || cat === '旁白') continue;
        if (!merged[cn]) merged[cn] = { langs: {}, cat, key, note };
        if (trans) {
          if (!merged[cn].langs[lang]) merged[cn].langs[lang] = new Set();
          merged[cn].langs[lang].add(trans);
        }
      }
    }

    TERMS = [];
    for (const cn in merged) {
      const d = merged[cn];
      const row = [cn];
      for (const lk of LANG_KEYS) {
        row.push(d.langs[lk] ? Array.from(d.langs[lk]).join(' | ') : '');
      }
      row.push(d.cat || '', d.key || '', d.note || '');
      TERMS.push(row);
    }

    rebuildIndex();
    updateStatsBar();
    finishUpdate('\u2705 批量导入完成！共 ' + TERMS.length.toLocaleString() + ' 条术语');
  } catch (e) {
    setUpdateStatus('error', '\u274C ' + e.message);
    console.error(e);
  }
}

/**
 * 单语言更新
 */
async function handleUpdateFile(file) {
  if (!file.name.match(/\.(xlsx|xls)$/i)) {
    setUpdateStatus('error', '\u274C 请选择 Excel 文件');
    return;
  }

  setUpdateStatus('loading', '\u23F3 正在读取...');
  document.getElementById('update-download-btn').style.display = 'none';

  try {
    const rows = await readExcel(file);
    setUpdateStatus('loading', '\u23F3 解析到 ' + rows.length.toLocaleString() + ' 行...');

    const updates = {};
    let dup = 0, long_f = 0, cat_f = 0;
    const seen = new Set();

    for (const row of rows) {
      const cn = String(row[0] || '').trim();
      const trans = String(row[1] || '').trim();
      const cat = String(row[3] || '').trim();
      const key = String(row[4] || '').trim();
      const note = String(row[6] || '').trim();

      if (!cn && !trans) continue;
      if (cn.length > 10 || trans.length > 15) { long_f++; continue; }
      if (cat === '剧情' || cat === '旁白') { cat_f++; continue; }

      const dk = cn + '|||' + trans;
      if (seen.has(dk)) { dup++; continue; }
      seen.add(dk);

      if (!updates[cn]) updates[cn] = { cn, cat, key, note };
      if (trans) {
        if (!updates[cn][updateLang]) updates[cn][updateLang] = new Set();
        updates[cn][updateLang].add(trans);
      }
    }

    // 更新已有术语
    for (let i = 0; i < TERMS.length; i++) {
      const cn = TERMS[i][0];
      if (updates[cn]) {
        const li = LANG_KEYS.indexOf(updateLang) + 1;
        const existing = new Set(TERMS[i][li] ? TERMS[i][li].split(' | ').filter(Boolean) : []);
        for (const t of (updates[cn][updateLang] || [])) existing.add(t);
        TERMS[i][li] = Array.from(existing).join(' | ');
        if (updates[cn].cat) TERMS[i][8] = updates[cn].cat;
        if (updates[cn].key) TERMS[i][9] = updates[cn].key;
        if (updates[cn].note) TERMS[i][10] = updates[cn].note;
      }
    }

    // 新增术语
    for (const cn in updates) {
      if (!TERMS.some(t => t[0] === cn)) {
        const u = updates[cn];
        const row = [u.cn];
        for (const lk of LANG_KEYS) {
          row.push(u[lk] ? Array.from(u[lk]).join(' | ') : '');
        }
        row.push(u.cat || '', u.key || '', u.note || '');
        TERMS.push(row);
      }
    }

    rebuildIndex();
    updateStatsBar();

    setUpdateStats(
      '语言：<b>' + LANG_EMOJI[updateLang] + ' ' + LANG_NAMES[updateLang] + '</b><br>'
      + '原始行数：<b>' + rows.length.toLocaleString() + '</b><br>'
      + '更新/新增：<b>' + Object.keys(updates).length.toLocaleString() + '</b> 条<br>'
      + '重复删除：<b>' + dup.toLocaleString() + '</b> 条<br>'
      + '超长过滤：<b>' + long_f.toLocaleString() + '</b> 条<br>'
      + '分类过滤：<b>' + cat_f.toLocaleString() + '</b> 条'
    );

    finishUpdate('\u2705 ' + LANG_NAMES[updateLang] + ' 术语表已更新！');
  } catch (e) {
    setUpdateStatus('error', '\u274C ' + e.message);
    console.error(e);
  }
}

/**
 * 完成更新，准备可下载的 JSON
 */
function finishUpdate(msg) {
  updatedTerms = JSON.stringify(TERMS);
  setUpdateStatus('success', msg);
  document.getElementById('update-download-btn').style.display = 'block';
}

/**
 * 下载更新后的 terms.json
 */
function downloadUpdatedJSON() {
  if (!updatedTerms) return;
  const blob = new Blob([updatedTerms], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'terms_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

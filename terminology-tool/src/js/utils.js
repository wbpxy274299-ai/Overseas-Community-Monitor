/* ========================================
   游戏术语校对工具 - 通用工具函数
   ======================================== */

/**
 * 标准化文本：将全角括号转为半角
 */
function normalize(s) {
  return s.replace(/[（）]/g, c => c === '（' ? '(' : ')');
}

/**
 * HTML 转义，防止 XSS
 */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

/**
 * 高亮关键词
 */
function highlight(text, query) {
  if (!query || !text) return esc(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return esc(text);
  return esc(text.substring(0, idx))
    + '<span class="highlight">' + esc(text.substring(idx, idx + query.length)) + '</span>'
    + esc(text.substring(idx + query.length));
}

/**
 * 检测 Excel 文件名对应的语言
 */
function detectLang(filename) {
  const lower = filename.toLowerCase();
  for (const [kw, lang] of Object.entries(FILE_LANG_MAP)) {
    if (lower.includes(kw)) return lang;
  }
  return null;
}

/**
 * 读取 Excel 文件并返回二维数组
 */
async function readExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
}

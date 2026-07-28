/* ========================================
   游戏术语校对工具 - 全局配置
   ======================================== */

const LANG_KEYS = ['jp', 'en', 'kr', 'tw', 'vn', 'id', 'th'];

const LANG_NAMES = {
  jp: '日语', en: '英语', kr: '韩语', tw: '繁中',
  vn: '越南语', id: '印尼语', th: '泰语'
};

const LANG_EMOJI = {
  jp: '\u{1F1EF}\u{1F1F5}', en: '\u{1F1EC}\u{1F1E7}', kr: '\u{1F1F0}\u{1F1F7}',
  tw: '\u{1F1F9}\u{1F1FC}', vn: '\u{1F1FB}\u{1F1F3}', id: '\u{1F1EE}\u{1F1E9}',
  th: '\u{1F1F9}\u{1F1ED}'
};

const FILE_LANG_MAP = {
  'jp': 'jp', 'ja': 'jp', '\u65E5': 'jp', 'japanese': 'jp',
  'en': 'en', '\u82F1\u8BED': 'en', 'english': 'en',
  'kr': 'kr', 'ko': 'kr', '\u97E9': 'kr', 'korean': 'kr',
  'tw': 'tw', '\u7E41': 'tw', 'traditional': 'tw', 'cht': 'tw',
  'vn': 'vn', 'vi': 'vn', '\u8D8A\u5357': 'vn', 'vietnamese': 'vn',
  'id': 'id', '\u5370\u5C3C': 'id', 'indonesian': 'id',
  'th': 'th', '\u6CF0': 'th', 'thai': 'th',
};

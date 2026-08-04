/**
 * Naver Game Lounge 爬虫模块
 * 用 Puppeteer（无头浏览器）抓取韩国社区帖子列表、帖子详情、玩家评论
 *
 * 比喻：这个模块就像一个"韩语秘书"，每天定时去论坛逛一圈，
 *       把帖子标题、内容、评论都抄下来，整理成表格交给你
 */

const puppeteer = require('puppeteer');
const log = require('./logger');
const db = require('./db');

// ===== 韩国时间解析（把韩文时间转成标准 ISO 格式）=====
// 比喻：把韩国秘书写的"3小时前"翻译成"2026-07-29 15:30:00"
function parseKoreanTime(timeStr, crawlTime) {
  if (!timeStr) return crawlTime || new Date().toISOString();
  
  // 1. 如果已经是 ISO 格式（datetime 属性），直接用
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(timeStr)) {
    return timeStr.replace('T', ' ');
  }
  
  // 2. 韩文日期格式：2026.07.29 15:30 或 2026.07.29.
  const dateMatch = timeStr.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})\.?\s*(\d{1,2}):(\d{2})/);
  if (dateMatch) {
    const [, y, m, d, h, min] = dateMatch;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')} ${h.padStart(2,'0')}:${min}:00`;
  }
  
  // 3. 相对时间：3시간 전 (3小时前), 5분 전 (5分钟前), 1일 전 (1天前)
  const baseTime = crawlTime ? new Date(crawlTime) : new Date();
  const relativeMatch = timeStr.match(/(\d+)\s*(시간|분|일|초|주|개월|년)/);
  if (relativeMatch) {
    const [, num, unit] = relativeMatch;
    const n = parseInt(num);
    switch (unit) {
      case '초': baseTime.setSeconds(baseTime.getSeconds() - n); break;
      case '분': baseTime.setMinutes(baseTime.getMinutes() - n); break;
      case '시간': baseTime.setHours(baseTime.getHours() - n); break;
      case '일': baseTime.setDate(baseTime.getDate() - n); break;
      case '주': baseTime.setDate(baseTime.getDate() - n * 7); break;
      case '개월': baseTime.setMonth(baseTime.getMonth() - n); break;
      case '년': baseTime.setFullYear(baseTime.getFullYear() - n); break;
    }
    const y = baseTime.getFullYear();
    const m = String(baseTime.getMonth() + 1).padStart(2, '0');
    const d = String(baseTime.getDate()).padStart(2, '0');
    const h = String(baseTime.getHours()).padStart(2, '0');
    const min = String(baseTime.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:00`;
  }
  
  // 4. 兜底：用抓取时间
  return crawlTime || new Date().toISOString();
}

// ===== 自动查找 Chrome 路径（三级兜底）=====
// 优先级：Puppeteer自带Chrome > 系统Chrome > 系统Chromium
// 每级都尝试，找到能用的就用，都不行再让 Puppeteer 自己处理
function findChromePath() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const platform = os.platform();

  // 第1级：Puppeteer 自带的 Chrome（最可靠，版本匹配）
  const puppeteerChromePaths = [];
  if (platform === 'linux') {
    // Puppeteer 在 Linux 上的默认安装路径
    const home = process.env.HOME || '/root';
    puppeteerChromePaths.push(
      path.join(home, '.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome'),
      path.join(home, '.cache/puppeteer/chrome/linux-*/chrome-linux/chrome'),
    );
  } else {
    puppeteerChromePaths.push(
      path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-*/chrome-win/chrome.exe'),
    );
  }
  // 也检查 node_modules 里的 puppeteer 缓存
  try {
    const puppeteerDir = require.resolve('puppeteer').replace(/\/[^/]+$/, '');
    puppeteerChromePaths.push(path.join(puppeteerDir, '.local-chromium', '**', 'chrome'));
  } catch (_) {}

  for (const pattern of puppeteerChromePaths) {
    try {
      const glob = require('path').dirname(pattern).replace(/\/\*\*?$/, '');
      if (fs.existsSync(glob)) {
        const entries = fs.readdirSync(glob);
        for (const entry of entries) {
          const chromePath = path.join(glob, entry, platform === 'win32' ? 'chrome.exe' : 'chrome');
          if (fs.existsSync(chromePath)) {
            console.log(`✅ 使用 Puppeteer 自带 Chrome: ${chromePath}`);
            return chromePath;
          }
        }
      }
    } catch (_) {}
  }

  // 第2级：系统 Chrome（Windows 本地开发）
  if (platform !== 'linux') {
    const systemPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of systemPaths) {
      try { if (fs.existsSync(p)) { console.log(`✅ 使用系统 Chrome: ${p}`); return p; } } catch (_) {}
    }
  }

  // 第3级：系统 Chromium（Linux 服务器兜底，版本可能不匹配但总比没有好）
  if (platform === 'linux') {
    const linuxPaths = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
    for (const p of linuxPaths) {
      try { if (fs.existsSync(p)) { console.log(`⚠️ 使用系统 Chromium（兜底）: ${p}`); return p; } } catch (_) {}
    }
  }

  console.log('⚠️ 未找到任何 Chrome/Chromium，将使用 Puppeteer 默认行为');
  return undefined;
}

// ===== 解析代理配置 =====
// 线上服务器（Linux）永远不用代理，直接访问
// 代理只在本地 Windows 开发环境生效
function getProxyArgs() {
  if (require('os').platform() === 'linux') return { args: [], auth: null, proxyHeader: null };
  const proxyUrl = process.env.HTTP_PROXY || '';
  if (!proxyUrl) return { args: [], auth: null, proxyHeader: null };
  try {
    const url = new URL(proxyUrl);
    const server = `${url.protocol}//${url.hostname}:${url.port}`;
    const auth = url.username ? {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    } : null;
    // ★ 生成 Proxy-Authorization 头（Base64 编码）
    let proxyHeader = null;
    if (auth) {
      const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      proxyHeader = `Basic ${credentials}`;
    }
    return { args: [`--proxy-server=${server}`], auth, proxyHeader };
  } catch (_) {
    return { args: [], auth: null, proxyHeader: null };
  }
}

// ===== 创建带代理认证的页面 =====
async function createPage(browser) {
  const page = await browser.newPage();
  const { auth } = getProxyArgs();
  if (auth) {
    // ★ 使用 Puppeteer 原生 authenticate（比 CDP header 更可靠）
    await page.authenticate(auth);
  }
  return page;
}

// ===== 配置 =====
const LOUNGE_CONFIG = {
  // 监控的游戏列表（可扩展多个游戏）
  games: [
    {
      code: 'Tree_Of_Savior_Neverland',
      name: 'Tree of Savior: Neverland',
      nameKr: '트리오브세이비어: 네버랜드',
      url: 'https://m.game.naver.com/lounge/Tree_Of_Savior_Neverland/board',
    },
  ],
  // 每次最多抓多少条帖子
  maxPosts: 300,
  // 每条帖子最多抓多少条评论
  maxComments: 30,
  // 页面加载超时（毫秒）
  pageTimeout: 60000,
  // 操作间隔（毫秒），太快会被封
  delayBetween: 2000,
  // 浏览器 User-Agent（伪装成手机）
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

// ===== 爬虫状态（防止并发）=====
let isCrawling = false;
let lastCrawlTime = null;
let lastCrawlResult = null;

// ===== 抓取进度追踪 =====
let crawlProgress = {
  step: 'idle',           // idle | list | filter | detail | save | done | error
  stepLabel: '待命',
  totalSteps: 0,
  currentStep: 0,
  message: '',
  postsFound: 0,
  postsCrawled: 0,
  commentsFound: 0,
};

function updateProgress(step, stepLabel, message, extra = {}) {
  crawlProgress = {
    ...crawlProgress,
    step,
    stepLabel,
    message,
    ...extra,
  };
  console.log(` 进度 [${stepLabel}]: ${message}`);
}

function getCrawlProgress() {
  return { ...crawlProgress };
}

function resetProgress() {
  crawlProgress = {
    step: 'idle',
    stepLabel: '待命',
    totalSteps: 0,
    currentStep: 0,
    message: '',
    postsFound: 0,
    postsCrawled: 0,
    commentsFound: 0,
  };
}

function getCrawlStatus() {
  return { isCrawling, lastCrawlTime, lastCrawlResult, progress: getCrawlProgress() };
}

// ===== 工具函数 =====

/**
 * 等待指定毫秒（给服务器喘口气，别太猛）
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 安全提取元素文本（找不到就返回空字符串，不会报错）
 */
async function safeText(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return '';
    return (await el.evaluate(node => node.textContent)).trim();
  } catch (_) {
    return '';
  }
}

/**
 * 安全提取元素属性
 */
async function safeAttr(page, selector, attr) {
  try {
    const el = await page.$(selector);
    if (!el) return '';
    return (await el.evaluate((node, a) => node.getAttribute(a) || '', attr)).trim();
  } catch (_) {
    return '';
  }
}

// ===== 核心：抓取帖子列表 =====

/**
 * 抓取 Lounge 帖子列表
 * 比喻：相当于打开论坛首页，把每篇帖子的"门牌号"记下来
 *
 * @param {Object} browser - Puppeteer 浏览器实例
 * @param {Object} game - 游戏配置对象
 * @returns {Array} 帖子列表 [{id, title, author, time, commentCount, viewCount, url}]
 */
async function crawlPostList(browser, game, options = {}) {
  const page = await createPage(browser);
  const allPosts = [];
  const seenIds = new Set();

  try {
    // 设置手机 UA（Naver 移动端页面结构更简单，更好抓）
    await page.setUserAgent(LOUNGE_CONFIG.userAgent);
    await page.setViewport({ width: 390, height: 844, isMobile: true });

    console.log(`📋 正在打开 ${game.name} 的 Lounge 页面...`);
    await page.goto(game.url, {
      waitUntil: 'domcontentloaded',
      timeout: LOUNGE_CONFIG.pageTimeout,
    });

    // 等待帖子列表加载（SPA 页面需要等 JS 渲染完）
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root');
        return root && root.children.length > 0;
      },
      { timeout: LOUNGE_CONFIG.pageTimeout }
    );
    await sleep(3000);

    // ★ 智能滚动：分批抓取，遇到 DB 已有的重复帖子就停止
    // 比喻：像翻相册，一页一页翻，发现照片都看过了就合上
    const existingMap = getExistingPosts();
    const existingIds = new Set(Object.keys(existingMap));
    const batchSize = 15;          // 每批期望新帖子数
    const maxScrollRounds = 15;    // 最多滚 15 轮
    const maxDuplicateRounds = 2;  // 连续 2 轮没新帖子就停
    let duplicateRounds = 0;

    for (let round = 0; round < maxScrollRounds; round++) {
      // 从当前页面 DOM 提取帖子列表（浏览器上下文内执行）
      const batchPosts = await page.evaluate((maxPosts) => {
        const results = [];
        const seen = new Set();
        const links = document.querySelectorAll('a[href*="/board/detail/"]');

        for (const link of links) {
          if (results.length >= maxPosts) break;
          const href = link.getAttribute('href') || '';
          const idMatch = href.match(/detail\/(\d+)/);
          if (!idMatch) continue;
          const postId = idMatch[1];
          if (seen.has(postId)) continue;
          seen.add(postId);

          const container = link.closest('[class*="board"]') || link.closest('[class*="item"]') || link.parentElement;
          const titleEl = link.querySelector('strong[class*="title"]');
          let title = titleEl ? titleEl.textContent.trim() : '';
          if (!title) title = link.textContent.trim().substring(0, 200);
          const authorEl = link.querySelector('span[class*="name"]') || container?.querySelector('span[class*="name"]');
          const author = authorEl ? authorEl.textContent.trim() : '';
          let time = '';
          const subSpans = link.querySelectorAll('span[class*="sub"]');
          for (const sp of subSpans) {
            const t = sp.textContent.trim();
            if (t && !t.includes('버프') && !t.includes('조회수')) { time = t; break; }
          }
          let commentCount = 0;
          const replyEl = link.querySelector('span[class*="reply"]');
          if (replyEl) { const m = replyEl.textContent.match(/\d+/); commentCount = m ? parseInt(m[0]) : 0; }
          let viewCount = 0;
          for (const sp of subSpans) {
            if (sp.textContent.includes('조회수')) { const m = sp.textContent.match(/[\d,]+/); viewCount = m ? parseInt(m[0].replace(/,/g, '')) : 0; break; }
          }
          results.push({ id: postId, title: title || '(无标题)', author, time, commentCount, viewCount,
            url: href.startsWith('http') ? href : `https://m.game.naver.com${href}` });
        }

        // 兆底策略2
        if (results.length === 0) {
          const allLinks = document.querySelectorAll('a[href*="/detail/"]');
          for (const link of allLinks) {
            if (results.length >= maxPosts) break;
            const href = link.getAttribute('href') || '';
            const idMatch = href.match(/detail\/(\d+)/);
            if (!idMatch || seen.has(idMatch[1])) continue;
            seen.add(idMatch[1]);
            results.push({ id: idMatch[1], title: link.textContent.trim() || '(无标题)',
              author: '', time: '', commentCount: 0, viewCount: 0,
              url: href.startsWith('http') ? href : `https://m.game.naver.com${href}` });
          }
        }
        return results;
      }, LOUNGE_CONFIG.maxPosts);

      // 检查哪些是 DB 里没有的新帖子
      let newInBatch = 0;
      for (const p of batchPosts) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          allPosts.push(p);
          if (!existingIds.has(p.id)) newInBatch++;
        }
      }

      console.log(`   📜 第${round + 1}轮：页面可见 ${batchPosts.length} 条，新增 ${newInBatch} 条（累计 ${allPosts.length}）`);

      if (newInBatch === 0) {
        duplicateRounds++;
        if (duplicateRounds >= maxDuplicateRounds) {
          console.log(`   🛑 连续 ${maxDuplicateRounds} 轮无新帖子，停止滚动`);
          break;
        }
      } else {
        duplicateRounds = 0;
      }

      if (allPosts.length >= LOUNGE_CONFIG.maxPosts) {
        console.log(`   📊 已达最大帖子数 ${LOUNGE_CONFIG.maxPosts}，停止滚动`);
        break;
      }

      // 滚动加载更多
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1500);
    }

    console.log(`✅ 帖子列表抓取完成：共 ${allPosts.length} 条`);

  } catch (err) {
    console.error(`❌ 帖子列表抓取失败: ${err.message}`);
    log.error('Lounge crawlPostList error', err.stack);
  } finally {
    await page.close();
  }

  return allPosts;
}

// ===== 核心：抓取帖子详情 + 评论 =====

/**
 * 抓取单条帖子的正文和评论
 * 比喻：打开一篇帖子，把正文和下面所有人的留言都抄下来
 *
 * @param {Object} browser - Puppeteer 浏览器实例
 * @param {Object} post - 帖子基本信息（来自列表）
 * @returns {Object} {content, images, comments: [{author, text, time, likes}]}
 */
async function crawlPostDetail(browser, post) {
  const page = await createPage(browser);
  const detail = { content: '', images: [], comments: [] };

  try {
    await page.setUserAgent(LOUNGE_CONFIG.userAgent);
    await page.setViewport({ width: 390, height: 844, isMobile: true });

    await page.goto(post.url, {
      waitUntil: 'networkidle2',
      timeout: LOUNGE_CONFIG.pageTimeout,
    });

    // 等待内容渲染
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root');
        return root && root.children.length > 0;
      },
      { timeout: LOUNGE_CONFIG.pageTimeout }
    );
    await sleep(5000); // 评论是异步加载的，需要多等一会儿

    // 提取正文内容（精准提取，排除页面导航/页脚等噪音）
    const extracted = await page.evaluate((maxComments) => {
      const result = { content: '', images: [], comments: [], detailTitle: '', detailAuthor: '', detailTime: '' };

      // ===== 噪音黑名单：这些文字不是帖子内容，是网页自带的 =====
      // 比喻：抄作业时，这些是课本背面的广告，不该抄
      const NOISE_PATTERNS = [
        '关闭', '去休息室', '用App查看', '用Chzzk',
        '更新公告', '问答', '直播', '热门帖子',
        '查看更多', '回到顶部',
        'Naver使用条款', '个人信息处理政策', 'Naver游戏客服中心',
        'NAVER Corp', '代表电话', '服务介绍',
        '登录后才能', '클린봇', '清洁机器人',
        '暂无评论', '第一个评论', '댓글이 없습니다', '첫번째 댓글',
        '로그인 후', '등록순',
        '버프', '너프',  // 投票按钮文字
      ];

      // 噪音标签：这些 HTML 元素里的文字一律不抄
      const NOISE_TAGS = new Set(['NAV', 'FOOTER', 'HEADER']);

      function isNoise(text) {
        const t = text.trim();
        if (t.length < 5) return true;  // 太短的碎片不要
        for (const p of NOISE_PATTERNS) {
          if (t.includes(p)) return true;
        }
        return false;
      }

      function isInsideNoiseTag(el) {
        let node = el;
        while (node) {
          if (NOISE_TAGS.has(node.tagName)) return true;
          node = node.parentElement;
        }
        return false;
      }

      // ===== 第1步：找帖子正文容器 =====
      // 优先级：正文专用容器 > article标签 > 标题父容器
      let bodyContainer = null;

      // ★ 优先找正文专用容器（这些容器确定不含评论区）
      // 比喻：先找"黑板"，找不到再找"教室"
      // 优先级：_content_12ncv(纯正文) > _wrap_content_10kn6(正文区) > nng-viewer
      const contentArea = document.querySelector('[class*="_content_12ncv"]')
        || document.querySelector('[class*="_wrap_content_10kn6"]')
        || document.querySelector('nng-viewer.contents')
        || document.querySelector('[class*="nng-viewer"]');
      if (contentArea && contentArea.textContent.length > 20) {
        bodyContainer = contentArea;
      }

      // 其次：article 标签
      if (!bodyContainer) {
        const articleEl = document.querySelector('article') || document.querySelector('[role="article"]');
        if (articleEl) bodyContainer = articleEl;
      }

      // 兜底：从标题往上找，但必须排除含评论区的容器
      if (!bodyContainer) {
        const titleEl = document.querySelector('strong[class*="feed_title"]') || document.querySelector('strong[class*="title"]');
        if (titleEl) {
          let parent = titleEl.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            const text = parent.textContent || '';
            // 容器文本长度合理
            if (text.length > 20 && text.length < 10000) {
              // ★ 关键：检查这个容器内是否有评论元素，有就跳过
              const hasReplyChild = parent.querySelector('[class*="_wrap_vjceo"], [class*="_type_comment"], [class*="_type_reply"]');
              if (!hasReplyChild) {
                bodyContainer = parent;
                break;
              }
            }
            parent = parent.parentElement;
          }
        }
      }

      // ===== 第2步：从容器中提取纯文本 =====
      if (bodyContainer) {
        const textParts = [];
        const seen = new Set();

        // ★ 用 TreeWalker 扫描容器内所有文字节点（能穿透 nng-viewer 等自定义元素）
        // 比喻：像用放大镜逐字扫描，不放过任何角落的文字
        const walker = document.createTreeWalker(bodyContainer, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (!parent) continue;

          // 跳过导航/页脚标签内的元素
          if (isInsideNoiseTag(parent)) continue;

          // ★ 检测是否在评论区内（祖先元素含评论 class 则跳过）
          let ancestor = parent;
          let inCommentSection = false;
          while (ancestor && ancestor !== bodyContainer) {
            const cn = (ancestor.getAttribute?.('class') || '').toLowerCase();
            if (cn.includes('_type_reply') || cn.includes('comment') || cn.includes('cmt')) {
              inCommentSection = true;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          if (inCommentSection) continue;

          const t = node.textContent.trim();
          if (!t || isNoise(t)) continue;
          if (seen.has(t)) continue;
          seen.add(t);
          textParts.push(t);
        }

        result.content = textParts.join('\n');
      }

      // 兜底：如果上面没拿到，用 TreeWalker 逐字扫描
      if (!result.content || result.content.length < 10) {
        const root = document.getElementById('root');
        if (root) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const parts = [];
          const seen2 = new Set();
          while (walker.nextNode()) {
            const t = walker.currentNode.textContent.trim();
            if (!t || isNoise(t)) continue;
            if (isInsideNoiseTag(walker.currentNode.parentElement)) continue;
            if (seen2.has(t)) continue;
            seen2.add(t);
            parts.push(t);
          }
          result.content = parts.join('\n');
        }
      }

      // 末尾清洗：去掉可能残留的法律/版权文字
      result.content = result.content.replace(/[\s\S]*(?:NAVER Corp|Naver使用条款|个人信息处理政策)[\s\S]*/i, '').trim();

      // 截断过长内容
      if (result.content.length > 5000) {
        result.content = result.content.substring(0, 5000) + '\n...(内容已截断)';
      }

      // ===== 图片（只取正文区域的图） =====
      const imgContainer = bodyContainer || document.getElementById('root');
      if (imgContainer) {
        const imgs = imgContainer.querySelectorAll('img');
        for (const img of imgs) {
          const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (src && !src.includes('emoji') && !src.includes('icon') && !src.includes('badge') && !src.includes('logo')) {
            result.images.push(src);
          }
        }
      }

      // ===== 标题 =====
      const titleEl = document.querySelector('strong[class*="feed_title"]') || document.querySelector('strong[class*="title"]');
      if (titleEl) result.detailTitle = titleEl.textContent.trim();

      // ===== 作者 =====
      const authorEl = document.querySelector('[class*="nick"], [class*="writer"], [class*="profile"] [class*="name"]');
      if (authorEl) result.detailAuthor = authorEl.textContent.trim();

      // ===== 时间 =====
      // Naver 用 _timestamp_12ncv 放时间（如 "07.31"），没有 datetime 属性
      const timeEl = document.querySelector('[class*="_timestamp"], time, [class*="_date"]');
      if (timeEl) result.detailTime = timeEl.getAttribute('datetime') || timeEl.textContent.trim();

      // ===== 评论（只取真实评论，排除输入框和提示文字）=====
      const seenComments = new Set();
      // ★ Naver 每条评论包在 _wrap_vjceo 里（旧版用 _type_reply，已失效）
      const commentItems = document.querySelectorAll(
        '[class*="_wrap_vjceo"]'
      );

      for (const item of commentItems) {
        if (result.comments.length >= maxComments) break;

        // 从每条评论里提取作者 + 文字
        const cAuthor = item.querySelector('[class*="_name_vjceo"]');
        // ★ 先找评论容器(_content_vjceo)，再取里面的文字(_text_vjceo)
        // 比喻：先找到评论的"信封"，再拆开来读里面的"信"
        const contentBox = item.querySelector('[class*="_content_vjceo"]');
        const cText = contentBox
          ? contentBox.querySelector('[class*="_text_vjceo"]') || contentBox
          : item.querySelector('[class*="_text_vjceo"]');
        // ★ 时间在 _sub_vjceo 或 _timestamp 里
        const cTime = item.querySelector('[class*="_timestamp"], [class*="_sub_vjceo"] span, [class*="_time"]');
        // ★ 点赞数在 _box_8ii1c 里（旧版用 like/good/thumb，已失效）
        const cLikes = item.querySelector('[class*="_box_8ii1c"], [class*="_like"], [class*="_good"], [class*="_thumb"]');

        const text = cText ? cText.textContent.trim() : '';
        if (!text || text.length < 2 || seenComments.has(text)) continue;
        if (isNoise(text)) continue;
        seenComments.add(text);

        result.comments.push({
          author: cAuthor ? cAuthor.textContent.trim() : '',
          text: text.substring(0, 1000),
          time: cTime ? (cTime.getAttribute('datetime') || cTime.textContent.trim()) : '',
          likes: cLikes ? (cLikes.textContent.match(/\d+/) || ['0'])[0] : '0',
        });
      }

      // 如果上面的选择器没匹配到评论，兜底：找评论列表容器
      if (result.comments.length === 0) {
        const commentArea = document.querySelector('[class*="_type_comment"], [class*="_list_xmzzc"], [class*="comment_list"]');
        if (commentArea) {
          // 在评论列表里找每个 _wrap_vjceo
          const items = commentArea.querySelectorAll('[class*="_wrap_vjceo"]');
          for (const item of items) {
            if (result.comments.length >= maxComments) break;
            const cAuthor = item.querySelector('[class*="_name_vjceo"]');
            const cText = item.querySelector('[class*="_text_vjceo"]');
            const text = cText ? cText.textContent.trim() : '';
            if (!text || text.length < 2 || seenComments.has(text) || isNoise(text)) continue;
            seenComments.add(text);
            result.comments.push({
              author: cAuthor ? cAuthor.textContent.trim() : '',
              text: text.substring(0, 1000),
              time: '',
              likes: '0',
            });
          }
        }
      }

      return result;
    }, LOUNGE_CONFIG.maxComments);

    detail.content = extracted.content;
    detail.images = extracted.images;
    detail.comments = extracted.comments;

    // 用详情页的信息补充列表信息（更准确）
    if (extracted.detailTitle) post.title = extracted.detailTitle;
    if (extracted.detailAuthor) post.author = extracted.detailAuthor;
    if (extracted.detailTime) post.time = extracted.detailTime;

    console.log(`  📄 帖子 #${post.id} 抓取完成：正文 ${detail.content.length} 字，评论 ${detail.comments.length} 条`);

  } catch (err) {
    console.error(`  ❌ 帖子 #${post.id} 详情抓取失败: ${err.message}`);
  } finally {
    await page.close();
  }

  return detail;
}

// ===== 排重：查询仓库里已有的帖子评论数 =====

/**
 * 从数据库查已有的帖子信息（评论数），用于判断是否需要重新打开
 * 比喻：翻开上次的成绩单，看上次打了多少分
 *
 * @returns {Object} { [postId]: { commentCount: number, crawledAt: string } }
 */
function getExistingPosts() {
  const map = {};
  try {
    const rows = db.queryAll(
      'SELECT post_id, comment_count, crawled_at FROM lounge_posts'
    );
    for (const row of rows) {
      map[row.post_id] = {
        commentCount: row.comment_count || 0,
        crawledAt: row.crawled_at || '',
      };
    }
  } catch (_) {}
  return map;
}

/**
 * 判断帖子是否近7天内发的
 * Naver 移动端时间格式："3시간 전"(3小时前)、"1일 전"(1天前)、"2026.07.29"(具体日期)
 *
 * @param {string} timeStr - 帖子时间字符串
 * @returns {boolean} 是否在近7天内
 */
function isRecentPost(timeStr) {
  if (!timeStr) return true; // 没时间信息的，保守起见当作新帖
  // 韩文相对时间：분(分钟)、시간(小时)、일(天)
  const minMatch = timeStr.match(/(\d+)\s*분/);
  if (minMatch) return true;
  const hourMatch = timeStr.match(/(\d+)\s*시간/);
  if (hourMatch) return parseInt(hourMatch[1]) <= 168; // 7天 = 168小时
  const dayMatch = timeStr.match(/(\d+)\s*일/);
  if (dayMatch) return parseInt(dayMatch[1]) <= 7;
  // "방금"(刚刚)、"어제"(昨天) 也算近期
  if (/방금|어제/.test(timeStr)) return true;
  // 具体日期格式 2026.07.29
  const dateMatch = timeStr.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (dateMatch) {
    const postDate = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return postDate >= sevenDaysAgo;
  }
  return true; // 无法解析的保守当作新帖
}

// ===== 主入口：完整抓取流程 =====

/**
 * 执行一次完整的 Lounge 抓取
 * 流程：打开列表 → 排重过滤 → 只打开需要的帖子 → 抓正文+评论
 *
 * @param {Object} options - 可选配置
 * @param {number} options.maxDetail - 最多抓多少条帖子的详情（默认全部）
 * @param {string} options.gameCode - 指定游戏（默认抓所有配置的游戏）
 * @returns {Object} {success, gameCode, posts, totalPosts, totalComments, crawlTime, error}
 */
async function crawlLounge(options = {}) {
  if (isCrawling) {
    console.log('⚠️ 爬虫正在运行中，跳过本次请求');
    return { success: false, error: '爬虫正在运行中' };
  }

  isCrawling = true;
  resetProgress();
  const startTime = Date.now();
  const result = {
    success: false,
    posts: [],
    totalPosts: 0,
    totalComments: 0,
    crawlTime: 0,
    skippedPosts: 0,
    error: null,
  };

  let browser = null;

  try {
    console.log('\n🚀 ===== Naver Lounge 爬虫启动 =====');
    updateProgress('starting', '启动中', '正在启动浏览器...', { totalSteps: 4, currentStep: 1 });

    // 启动无头浏览器
    const { args: proxyArgs } = getProxyArgs();
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || findChromePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--lang=ko-KR',
        ...proxyArgs,
      ],
    });

    // 确定要抓哪些游戏
    let games = LOUNGE_CONFIG.games;
    if (options.gameCode) {
      games = games.filter(g => g.code === options.gameCode);
      if (games.length === 0) {
        throw new Error(`未找到游戏: ${options.gameCode}`);
      }
    }

    for (const game of games) {
      console.log(`\n🎮 开始抓取: ${game.name}`);

      // 第一步：抓帖子列表
      updateProgress('list', '抓取列表', `正在获取 ${game.name} 帖子列表...`, { currentStep: 1 });
      const postList = await crawlPostList(browser, game, options);
      if (postList.length === 0) {
        console.log(`⚠️ ${game.name} 没有抓到任何帖子`);
        continue;
      }
      updateProgress('list', '列表完成', `获取到 ${postList.length} 条帖子`, { postsFound: postList.length });

      // 第二步：排重过滤 — 决定哪些帖子需要打开详情页
      // 比喻：老师批作业前先看名单，上次批过且没改过的直接跳过
      updateProgress('filter', '排重过滤', '正在分析帖子...', { currentStep: 2 });
      const existingMap = getExistingPosts();
      const postsToOpen = [];    // 需要打开详情页的帖子
      const postsToSkip = [];    // 跳过的帖子（DB已有完整数据）
      const postsBasicOnly = []; // 只存基本信息的帖子（超出详情页数量限制）

      const maxDetail = options.maxDetail || postList.length;
      let detailCount = 0;

      for (const post of postList) {
        // 超过详情页数量限制的，只存基本信息
        if (detailCount >= maxDetail) {
          postsBasicOnly.push(post);
          continue;
        }

        const existing = existingMap[post.id];
        const isRecent = isRecentPost(post.time);

        if (!existing) {
          // 全新帖子，必须打开
          postsToOpen.push(post);
          detailCount++;
        } else if (isRecent) {
          // 近2天的帖子，总是重新打开（可能有新评论）
          postsToOpen.push(post);
          detailCount++;
        } else if (post.commentCount > existing.commentCount) {
          // 老帖子但评论增加了，打开看新评论
          postsToOpen.push(post);
          detailCount++;
        } else {
          // 评论没增加（持平或减少），跳过
          postsToSkip.push(post);
        }
      }

      console.log(`📋 排重结果：需打开 ${postsToOpen.length} 条，跳过 ${postsToSkip.length} 条（评论未增加）`);
      updateProgress('filter', '排重完成', `需打开 ${postsToOpen.length} 条，跳过 ${postsToSkip.length} 条`, { totalSteps: 4, currentStep: 2 });

      // 第三步：逐个打开需要抓的帖子详情
      updateProgress('detail', '抓取详情', `开始抓取 ${postsToOpen.length} 条帖子详情...`, { currentStep: 3, totalSteps: 3 + postsToOpen.length });
      for (let i = 0; i < postsToOpen.length; i++) {
        const post = postsToOpen[i];
        console.log(`  [${i + 1}/${postsToOpen.length}] 正在抓取: ${post.title.substring(0, 30)}...`);
        updateProgress('detail', '抓取详情', `[${i + 1}/${postsToOpen.length}] ${post.title.substring(0, 40)}...`, { currentStep: 3 + i, postsCrawled: i });

        const detail = await crawlPostDetail(browser, post);

        result.posts.push({
          ...post,
          gameCode: game.code,
          gameName: game.name,
          content: detail.content,
          images: detail.images,
          comments: detail.comments,
          crawledAt: new Date().toISOString(),
        });

        result.totalComments += detail.comments.length;

        if (i < postsToOpen.length - 1) {
          await sleep(LOUNGE_CONFIG.delayBetween);
        }
      }

      result.totalPosts += postList.length;
      result.skippedPosts += postsToSkip.length;

      // 只存基本信息的帖子（超出限制的）
      for (const post of postsBasicOnly) {
        result.posts.push({
          ...post,
          gameCode: game.code,
          gameName: game.name,
          content: '',
          images: [],
          comments: [],
          crawledAt: new Date().toISOString(),
        });
      }
    }

    result.success = true;
    result.crawlTime = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n✅ ===== 抓取完成 =====`);
    console.log(`   帖子: ${result.posts.length} 条（列表共 ${result.totalPosts} 条，跳过 ${result.skippedPosts} 条）`);
    console.log(`   评论: ${result.totalComments} 条`);
    console.log(`   耗时: ${result.crawlTime} 秒`);
    updateProgress('done', '抓取完成', `帖子 ${result.posts.length} 条，评论 ${result.totalComments} 条，耗时 ${result.crawlTime} 秒`, {
      currentStep: 100,
      totalSteps: 100,
      postsCrawled: result.posts.length,
      commentsFound: result.totalComments,
    });

  } catch (err) {
    result.error = err.message;
    console.error(`\n❌ 爬虫执行失败: ${err.message}`);
    updateProgress('error', '抓取失败', err.message, { currentStep: 100, totalSteps: 100 });
    log.error('Lounge crawl error', err.stack);
  } finally {
    if (browser) {
      await browser.close();
    }
    isCrawling = false;
    lastCrawlTime = new Date().toISOString();
    lastCrawlResult = {
      success: result.success,
      postCount: result.posts.length,
      commentCount: result.totalComments,
      crawlTime: result.crawlTime,
      error: result.error,
    };
  }

  return result;
}

// ===== 单帖重爬（管理后台调用）=====

/**
 * 重新爬取指定帖子的内容和评论
 * @param {string} postId - Lounge 原始帖子ID
 * @returns {Object} { success, message, detail }
 */
async function recrawlPost(postId) {
  // 查帖子信息
  const post = db.queryOne('SELECT * FROM lounge_posts WHERE post_id = ?', [postId]);
  if (!post) return { success: false, message: '帖子不存在' };
  if (!post.url) return { success: false, message: '帖子无URL，无法重爬' };

  let browser = null;
  try {
    const proxyArgs = getProxyArgs();
    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyArgs.args],
    };
    const chromePath = findChromePath();
    if (chromePath) launchOpts.executablePath = chromePath;
    browser = await puppeteer.launch(launchOpts);

    const detail = await crawlPostDetail(browser, {
      url: post.url,
      id: postId,
      title: post.title,
    });

    // 更新数据库
    if (detail.content) {
      db.getDb().run(
        `UPDATE lounge_posts SET content = ?, images = ? WHERE post_id = ?`,
        [detail.content, JSON.stringify(detail.images || []), postId]
      );
    }

    // 更新评论（先删旧的，再插新的）
    db.getDb().run('DELETE FROM lounge_comments WHERE post_id = ?', [postId]);
    for (const comment of (detail.comments || [])) {
      db.getDb().run(
        `INSERT INTO lounge_comments (post_id, game_code, author, content, comment_time, likes, crawled_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now','+8 hours'))`,
        [postId, post.game_code, comment.author, comment.text,
         comment.time, parseInt(comment.likes) || 0]
      );
    }
    db.saveDb();

    console.log(`  [重爬] 帖子 ${postId} 更新完成：评论 ${detail.comments?.length || 0} 条`);
    return { success: true, message: '重爬完成', detail: { content: detail.content?.substring(0, 100), comments: detail.comments?.length || 0 } };
  } catch (e) {
    console.error(`  [重爬] 帖子 ${postId} 失败:`, e.message);
    return { success: false, message: e.message };
  } finally {
    if (browser) try { await browser.close(); } catch (_) {}
  }
}

// ===== 导出 =====
module.exports = {
  crawlLounge,
  getCrawlStatus,
  getCrawlProgress,
  recrawlPost,
  LOUNGE_CONFIG,
  parseKoreanTime,
};

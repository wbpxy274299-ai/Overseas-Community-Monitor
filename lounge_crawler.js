/**
 * Naver Game Lounge 爬虫模块
 * 用 Puppeteer（无头浏览器）抓取韩国社区帖子列表、帖子详情、玩家评论
 *
 * 比喻：这个模块就像一个"韩语秘书"，每天定时去论坛逛一圈，
 *       把帖子标题、内容、评论都抄下来，整理成表格交给你
 */

const puppeteer = require('puppeteer');
const log = require('./logger');

// ===== 自动查找 Chrome 路径 =====
function findChromePath() {
  const fs = require('fs');
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  for (const p of paths) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return undefined; // 找不到就用 Puppeteer 自带的
}

// ===== 解析代理配置 =====
function getProxyArgs() {
  const proxyUrl = process.env.HTTP_PROXY || '';
  if (!proxyUrl) return { args: [], auth: null };
  try {
    const url = new URL(proxyUrl);
    const server = `${url.protocol}//${url.hostname}:${url.port}`;
    const auth = url.username ? {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    } : null;
    return { args: [`--proxy-server=${server}`], auth };
  } catch (_) {
    return { args: [], auth: null };
  }
}

// ===== 创建带代理认证的页面 =====
async function createPage(browser) {
  const page = await browser.newPage();
  const { auth } = getProxyArgs();
  if (auth) {
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

function getCrawlStatus() {
  return { isCrawling, lastCrawlTime, lastCrawlResult };
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
  const posts = [];

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
    // 比喻：餐厅开门了，但菜还没端上来，得等厨师做好
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root');
        return root && root.children.length > 0;
      },
      { timeout: LOUNGE_CONFIG.pageTimeout }
    );

    // 额外等一下，确保异步数据加载完
    await sleep(3000);

    // 滚动加载更多帖子（Lounge 是无限滚动/分页的）
    const scrollTimes = options.scrollTimes || 3;
    for (let i = 0; i < scrollTimes; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1500);
    }

    // 回到顶部
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    // 提取帖子列表
    // 注意：Naver 用 CSS Modules，类名带哈希（如 board_item__xxx），所以用模糊匹配
    posts.push(...await page.evaluate((maxPosts) => {
      const results = [];

      // 策略1：找所有帖子链接（最可靠的方式）
      const links = document.querySelectorAll('a[href*="/board/detail/"]');
      const seen = new Set();

      for (const link of links) {
        if (results.length >= maxPosts) break;

        const href = link.getAttribute('href') || '';
        const idMatch = href.match(/detail\/(\d+)/);
        if (!idMatch) continue;

        const postId = idMatch[1];
        if (seen.has(postId)) continue;
        seen.add(postId);

        // 从链接的父容器中提取信息
        const container = link.closest('[class*="board"]') || link.closest('[class*="item"]') || link.parentElement;

        // 标题：精确匹配 strong[class*="title"]（Naver Lounge 的标准标题元素）
        const titleEl = link.querySelector('strong[class*="title"]');
        let title = titleEl ? titleEl.textContent.trim() : '';
        // 兜底：用链接文本
        if (!title) title = link.textContent.trim().substring(0, 200);

        // 分类标签
        const labelEl = link.querySelector('span[class*="label"]');
        const category = labelEl ? labelEl.textContent.trim() : '';

        // 作者：精确匹配 span[class*="name"]
        const authorEl = link.querySelector('span[class*="name"]') || container?.querySelector('span[class*="name"]');
        const author = authorEl ? authorEl.textContent.trim() : '';

        // 时间：找 span[class*="sub"] 中不含 버프/조회수 的那个
        let time = '';
        const subSpans = link.querySelectorAll('span[class*="sub"]');
        for (const sp of subSpans) {
          const t = sp.textContent.trim();
          if (t && !t.includes('버프') && !t.includes('조회수')) {
            time = t;
            break;
          }
        }

        // 评论数：精确匹配 span[class*="reply"] 或 span[class*="number"]
        let commentCount = 0;
        const replyEl = link.querySelector('span[class*="reply"]');
        if (replyEl) {
          const numMatch = replyEl.textContent.match(/\d+/);
          commentCount = numMatch ? parseInt(numMatch[0]) : 0;
        }

        // 浏览量：找含 조회수 的 span[class*="sub"]
        let viewCount = 0;
        for (const sp of subSpans) {
          if (sp.textContent.includes('조회수')) {
            const numMatch = sp.textContent.match(/[\d,]+/);
            viewCount = numMatch ? parseInt(numMatch[0].replace(/,/g, '')) : 0;
            break;
          }
        }

        results.push({
          id: postId,
          title: title || '(无标题)',
          author,
          time,
          commentCount,
          viewCount,
          url: href.startsWith('http') ? href : `https://m.game.naver.com${href}`,
        });
      }

      // 策略2：如果策略1没抓到，尝试更宽泛的选择器
      if (results.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/detail/"]');
        for (const link of allLinks) {
          if (results.length >= maxPosts) break;
          const href = link.getAttribute('href') || '';
          const idMatch = href.match(/detail\/(\d+)/);
          if (!idMatch || seen.has(idMatch[1])) continue;
          seen.add(idMatch[1]);

          results.push({
            id: idMatch[1],
            title: link.textContent.trim() || '(无标题)',
            author: '',
            time: '',
            commentCount: 0,
            viewCount: 0,
            url: href.startsWith('http') ? href : `https://m.game.naver.com${href}`,
          });
        }
      }

      return results;
    }, LOUNGE_CONFIG.maxPosts));

    console.log(`✅ 帖子列表抓取完成：共 ${posts.length} 条`);

  } catch (err) {
    console.error(`❌ 帖子列表抓取失败: ${err.message}`);
    log.error('Lounge crawlPostList error', err.stack);
  } finally {
    await page.close();
  }

  return posts;
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
    await sleep(2000);

    // 提取正文内容
    const extracted = await page.evaluate((maxComments) => {
      const result = { content: '', images: [], comments: [], detailTitle: '', detailAuthor: '', detailTime: '' };

      // 正文：找最大的文本块
      const contentSelectors = [
        '[class*="content"]', '[class*="body"]', '[class*="article"]',
        '[class*="post"]', '[class*="detail"]', '[class*="text"]',
      ];
      for (const sel of contentSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = el.textContent.trim();
          if (text.length > result.content.length && text.length > 10) {
            result.content = text;
          }
        }
      }

      // 如果上面没抓到，用 body 的 main 区域
      if (!result.content) {
        const main = document.querySelector('main, [role="main"], #root > div > div');
        if (main) result.content = main.textContent.trim().substring(0, 5000);
      }

      // 截断过长内容
      if (result.content.length > 5000) {
        result.content = result.content.substring(0, 5000) + '\n...(内容已截断)';
      }

      // 图片
      const imgs = document.querySelectorAll('[class*="content"] img, [class*="article"] img, [class*="body"] img');
      for (const img of imgs) {
        const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (src && !src.includes('emoji') && !src.includes('icon')) {
          result.images.push(src);
        }
      }

      // 标题：精确匹配详情页标题元素
      const titleEl = document.querySelector('strong[class*="feed_title"]') || document.querySelector('strong[class*="title"]');
      if (titleEl) result.detailTitle = titleEl.textContent.trim();

      // 作者
      const authorEl = document.querySelector('[class*="author"], [class*="nick"], [class*="writer"], [class*="profile"] [class*="name"]');
      if (authorEl) result.detailAuthor = authorEl.textContent.trim();

      // 时间
      const timeEl = document.querySelector('[class*="date"], [class*="time"], time');
      if (timeEl) result.detailTime = timeEl.getAttribute('datetime') || timeEl.textContent.trim();

      // 评论：找评论区域
      const commentSelectors = [
        '[class*="comment"]', '[class*="reply"]', '[class*="cmt"]',
      ];
      const seenComments = new Set();

      for (const sel of commentSelectors) {
        const commentEls = document.querySelectorAll(sel);
        for (const el of commentEls) {
          if (result.comments.length >= maxComments) break;

          const text = el.textContent.trim();
          if (!text || text.length < 2 || seenComments.has(text)) continue;

          // 排除评论输入框等非评论内容
          if (el.querySelector('input, textarea, button[class*="submit"]')) continue;

          seenComments.add(text);

          // 尝试从评论元素内部提取结构化信息
          const cAuthor = el.querySelector('[class*="nick"], [class*="name"], [class*="writer"], [class*="author"]');
          const cTime = el.querySelector('[class*="date"], [class*="time"], time');
          const cLikes = el.querySelector('[class*="like"], [class*="good"], [class*="thumb"]');

          result.comments.push({
            author: cAuthor ? cAuthor.textContent.trim() : '',
            text: text.substring(0, 1000),
            time: cTime ? (cTime.getAttribute('datetime') || cTime.textContent.trim()) : '',
            likes: cLikes ? (cLikes.textContent.match(/\d+/) || ['0'])[0] : '0',
          });
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

// ===== 主入口：完整抓取流程 =====

/**
 * 执行一次完整的 Lounge 抓取
 * 流程：打开列表 → 抓帖子标题 → 逐个打开帖子 → 抓正文+评论
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
  const startTime = Date.now();
  const result = {
    success: false,
    posts: [],
    totalPosts: 0,
    totalComments: 0,
    crawlTime: 0,
    error: null,
  };

  let browser = null;

  try {
    console.log('\n🚀 ===== Naver Lounge 爬虫启动 =====');

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
      const postList = await crawlPostList(browser, game, options);
      if (postList.length === 0) {
        console.log(`⚠️ ${game.name} 没有抓到任何帖子`);
        continue;
      }

      // 第二步：逐个抓帖子详情
      const maxDetail = options.maxDetail || postList.length;
      const detailPosts = postList.slice(0, maxDetail);

      for (let i = 0; i < detailPosts.length; i++) {
        const post = detailPosts[i];
        console.log(`  [${i + 1}/${detailPosts.length}] 正在抓取帖子: ${post.title.substring(0, 30)}...`);

        const detail = await crawlPostDetail(browser, post);

        // 合并列表信息和详情信息
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

        // 每个帖子之间等一下，别太猛
        if (i < detailPosts.length - 1) {
          await sleep(LOUNGE_CONFIG.delayBetween);
        }
      }

      result.totalPosts += postList.length;

      // 未抓详情的帖子也加入结果（只更新标题、作者、时间等基本信息）
      const remainingPosts = postList.slice(maxDetail);
      for (const post of remainingPosts) {
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
    console.log(`   帖子: ${result.posts.length} 条（列表共 ${result.totalPosts} 条）`);
    console.log(`   评论: ${result.totalComments} 条`);
    console.log(`   耗时: ${result.crawlTime} 秒`);

  } catch (err) {
    result.error = err.message;
    console.error(`\n❌ 爬虫执行失败: ${err.message}`);
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

// ===== 导出 =====
module.exports = {
  crawlLounge,
  getCrawlStatus,
  LOUNGE_CONFIG,
};

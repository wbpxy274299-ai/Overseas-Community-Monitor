/**
 * Naver Game Lounge 爬虫模块（axios + cheerio 版）
 * 直接调用 Naver 内部 API，不再依赖无头浏览器
 *
 * 比喻：这个模块就像一个"韩语秘书"，每天定时去论坛逛一圈，
 *       把帖子标题、内容、评论都抄下来，整理成表格交给你
 */

const axios = require('axios');
const cheerio = require('cheerio');
const log = require('./logger');
const db = require('./db');
const { fmtCST8 } = require('./config');

// ===== 韩国时间解析（把韩文时间转成标准 ISO 格式）=====
function parseKoreanTime(timeStr, crawlTime) {
  if (!timeStr) return crawlTime || fmtCST8(new Date());
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(timeStr)) return timeStr.replace('T', ' ');
  const dateMatch = timeStr.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})\.?\s*(\d{1,2}):(\d{2})/);
  if (dateMatch) {
    const [, y, m, d, h, min] = dateMatch;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')} ${h.padStart(2,'0')}:${min}:00`;
  }
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
  return crawlTime || fmtCST8(new Date());
}

// ===== Naver API 基础配置 =====
const API_BASE = 'https://comm-api.game.naver.com/nng_main/v1';
const COMMENT_API_BASE = 'https://apis.naver.com/nng_main/nng_comment_api/v1';

const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json',
  'Referer': 'https://m.game.naver.com/',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

async function apiGet(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, { headers: API_HEADERS, timeout: 30000 });
    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
      const isNetwork = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      const status = err.response?.status;

      // 4xx 错误不重试（参数错误等）
      if (status && status >= 400 && status < 500) {
        throw err;
      }

      if (attempt < retries && (isTimeout || isNetwork || !status)) {
        const wait = attempt * 3000; // 3s, 6s 递增等待
        console.log(`   ⏳ API 请求超时/网络错误 (第${attempt}次)，${wait/1000}s 后重试... (${err.code || err.message?.substring(0,50)})`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

// ===== 配置 =====
const LOUNGE_CONFIG = {
  games: [
    {
      code: 'Tree_Of_Savior_Neverland',
      name: 'Tree of Savior: Neverland',
      nameKr: '트리오브세이비어: 네버랜드',
      url: 'https://m.game.naver.com/lounge/Tree_Of_Savior_Neverland/board',
    },
  ],
  maxComments: 30,  // 每帖最多抓30条评论
  delayBetween: 1000,
};

// ===== 爬虫状态（防止并发）=====
let isCrawling = false;
let lastCrawlTime = null;
let lastCrawlResult = null;

// ===== 抓取进度追踪 =====
let crawlProgress = {
  step: 'idle',
  stepLabel: '待命',
  totalSteps: 0,
  currentStep: 0,
  message: '',
  postsFound: 0,
  postsCrawled: 0,
  commentsFound: 0,
};

function updateProgress(step, stepLabel, message, extra = {}) {
  crawlProgress = { ...crawlProgress, step, stepLabel, message, ...extra };
  console.log(` 进度 [${stepLabel}]: ${message}`);
}

function getCrawlProgress() {
  return { ...crawlProgress };
}

function resetProgress() {
  crawlProgress = { step: 'idle', stepLabel: '待命', totalSteps: 0, currentStep: 0, message: '', postsFound: 0, postsCrawled: 0, commentsFound: 0 };
}

function getCrawlStatus() {
  return { isCrawling, lastCrawlTime, lastCrawlResult, progress: getCrawlProgress() };
}

// ===== 工具函数 =====
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 解析 Naver SE (Smart Editor) 的 JSON contents，提取纯文本和图片
 */
function parseContentsJSON(contentsStr) {
  const result = { text: '', images: [] };
  try {
    const doc = typeof contentsStr === 'string' ? JSON.parse(contentsStr) : contentsStr;
    const components = doc?.document?.components || [];
    const textParts = [];
    for (const comp of components) {
      if (comp['@ctype'] === 'text') {
        const values = comp.value || [];
        for (const v of values) {
          if (v['@ctype'] === 'paragraph') {
            const nodes = v.nodes || [];
            const paraText = nodes.filter(n => n['@ctype'] === 'textNode').map(n => n.value || '').join('');
            if (paraText.trim()) textParts.push(paraText.trim());
          }
        }
      } else if (comp['@ctype'] === 'image') {
        const src = comp.src || '';
        if (src && !src.includes('emoji') && !src.includes('icon') && !src.includes('logo')) {
          result.images.push(src);
        }
      }
    }
    result.text = textParts.join('\n');
  } catch (_) {}
  return result;
}

/**
 * 解析详情 API 返回的 HTML contents，提取纯文本和图片
 */
function parseContentsHTML(html) {
  const result = { text: '', images: [] };
  try {
    const $ = cheerio.load(html);
    // 提取文本
    const textParts = [];
    $('.se-text-paragraph span').each((i, el) => {
      const t = $(el).text().trim();
      if (t && t !== '\u200B' && t !== '') textParts.push(t);
    });
    result.text = textParts.join('\n');
    // 提取图片
    $('.se-image img, .se-module-image img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && !src.includes('emoji') && !src.includes('icon') && !src.includes('logo')) {
        result.images.push(src);
      }
    });
  } catch (_) {}
  return result;
}

/**
 * 解析 Naver 日期格式，支持多种可能的 API 返回格式：
 * - 14位数字字符串 "20260805101700" => "2026-08-05 10:17:00"（韩国本地时间，原样提取）
 * - 毫秒时间戳 (数字) 1722834000000 => 直接转 ISO（时间戳是绝对时间，不加偏移）
 * - ISO 格式 "2026-08-05T01:17:00.000Z" => 直接提取 UTC 时间
 * - 已经是 "YYYY-MM-DD HH:mm:ss" 格式 => 原样返回
 */
function parseNaverDate(dateStr) {
  if (!dateStr) return fmtCST8(new Date());

  // 如果是数字（毫秒时间戳），直接转 ISO — 时间戳是绝对时间，不需要加时区偏移
  if (typeof dateStr === 'number') {
    return fmtCST8(new Date(dateStr));
  }

  const str = String(dateStr).trim();

  // 如果已经是 "YYYY-MM-DD HH:mm:ss" 或 "YYYY-MM-DDTHH:mm:ss" 格式，直接返回
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(str)) {
    return str.replace('T', ' ').substring(0, 19);
  }

  // 14位紧凑格式 "20260805101700" — 这是韩国本地时间，原样拆分
  if (/^\d{14}$/.test(str)) {
    return `${str.substring(0,4)}-${str.substring(4,6)}-${str.substring(6,8)} ${str.substring(8,10)}:${str.substring(10,12)}:${str.substring(12,14)}`;
  }

  // 字符串形式的数字时间戳（10位秒级或13位毫秒级）
  if (/^\d{10,13}$/.test(str)) {
    const ts = str.length === 10 ? parseInt(str) * 1000 : parseInt(str);
    return fmtCST8(new Date(ts));
  }

  // 最后兜底：尝试 Date 构造器（不加偏移）
  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) {
    return fmtCST8(fallback);
  }

  console.warn('⚠️ 无法解析的日期格式:', JSON.stringify(dateStr), '(类型:', typeof dateStr, ')');
  return fmtCST8(new Date());
}

// ===== 核心：抓取帖子列表（通过 API）=====

async function crawlPostList(game, options = {}) {
  const allPosts = [];
  const seenIds = new Set();
  const limit = 30; // 每批30条
  let offset = 0;
  const minDate = options.minDate || '2026-05-01'; // 默认不抓5月之前的数据

  try {
    console.log(` 正在通过 API 获取 ${game.name} 帖子列表（增量模式）...`);
    const existingMap = getExistingPosts();
    const existingIds = new Set(Object.keys(existingMap));

    while (true) {
      const url = `${API_BASE}/community/lounge/${game.code}/feed?buffFilteringYN=N&limit=${limit}&offset=${offset}&order=NEW`;
      let res;
      let batchRetries = 0;
      while (batchRetries < 2) {
        try {
          res = await apiGet(url);
          break;
        } catch (apiErr) {
          batchRetries++;
          const status = apiErr.response?.status || apiErr.code || 'NETWORK';
          console.error(`   ❌ API 请求失败 (offset=${offset}, 第${batchRetries}次): ${status}`);
          if (batchRetries >= 2) {
            console.error(`   ⛔ 本批放弃，停止抓取`);
            break;
          }
          await sleep(5000);
        }
      }
      if (!res) break;
      const feeds = res.data?.content?.feeds || [];
      if (feeds.length === 0) break;

      // 检查这批的排重情况 + 日期截止
      let dupInBatch = 0;
      let newInBatch = 0;
      let tooOld = false;
      for (const item of feeds) {
        const feed = item.feed || {};
        const postId = String(feed.feedId);
        if (existingIds.has(postId)) dupInBatch++;
        else newInBatch++;
        // 检查帖子日期，超过 cutoff 就停
        const postDate = parseNaverDate(feed.createdDate);
        if (postDate && postDate.substring(0, 10) < minDate) {
          tooOld = true;
        }
      }

      console.log(`   📜 offset=${offset}：本批 ${feeds.length} 条，新增 ${newInBatch}，重复 ${dupInBatch}（累计 ${allPosts.length}）`);

      // 如果这批有帖子日期早于 cutoff，停止抓取
      if (tooOld) {
        console.log(`   🛑 遇到 ${minDate} 之前的帖子，停止抓取`);
        // 但这批里日期合格的新帖子还是要收进来
        for (const item of feeds) {
          const feed = item.feed || {};
          const postId = String(feed.feedId);
          const postDate = parseNaverDate(feed.createdDate);
          if (!seenIds.has(postId) && !existingIds.has(postId) && postDate && postDate.substring(0, 10) >= minDate) {
            seenIds.add(postId);
            const user = item.user || {};
            const comment = item.comment || {};
            allPosts.push({
              id: postId,
              title: feed.title || '(无标题)',
              author: user.nickname || '',
              time: postDate,
              commentCount: comment.totalCount || 0,
              viewCount: item.readCount || 0,
              url: `https://m.game.naver.com/lounge/${game.code}/board/detail/${feed.feedId}`,
              repImageUrl: feed.repImageUrl || '',
              buff: feed.buff || 0,
              nerf: feed.nerf || 0,
              _contentsJSON: feed.contents || '',
            });
          }
        }
        break;
      }

      // 如果这批大部分是重复的（>70%），说明已经抓到旧数据了，停止
      if (feeds.length > 0 && dupInBatch / feeds.length > 0.7) {
        console.log(`   🛑 本批重复率 ${Math.round(dupInBatch/feeds.length*100)}%，停止抓取`);
        // 但这批里的新帖子还是要收进来
        for (const item of feeds) {
          const feed = item.feed || {};
          const postId = String(feed.feedId);
          if (!seenIds.has(postId) && !existingIds.has(postId)) {
            seenIds.add(postId);
            const user = item.user || {};
            const comment = item.comment || {};
            allPosts.push({
              id: postId,
              title: feed.title || '(无标题)',
              author: user.nickname || '',
              time: parseNaverDate(feed.createdDate),
              commentCount: comment.totalCount || 0,
              viewCount: item.readCount || 0,
              url: `https://m.game.naver.com/lounge/${game.code}/board/detail/${feed.feedId}`,
              repImageUrl: feed.repImageUrl || '',
              buff: feed.buff || 0,
              nerf: feed.nerf || 0,
              _contentsJSON: feed.contents || '',
            });
          }
        }
        break;
      }

      // 正常收进这批帖子
      for (const item of feeds) {
        const feed = item.feed || {};
        const user = item.user || {};
        const comment = item.comment || {};
        const postId = String(feed.feedId);
        if (seenIds.has(postId)) continue;
        seenIds.add(postId);

        if (allPosts.length === 0) {
          console.log(`   🔍 [调试] 第一条帖子原始日期: ${JSON.stringify(feed.createdDate)} (类型: ${typeof feed.createdDate})，解析后: ${parseNaverDate(feed.createdDate)}`);
        }

        allPosts.push({
          id: postId,
          title: feed.title || '(无标题)',
          author: user.nickname || '',
          time: parseNaverDate(feed.createdDate),
          commentCount: comment.totalCount || 0,
          viewCount: item.readCount || 0,
          url: `https://m.game.naver.com/lounge/${game.code}/board/detail/${feed.feedId}`,
          repImageUrl: feed.repImageUrl || '',
          buff: feed.buff || 0,
          nerf: feed.nerf || 0,
          _contentsJSON: feed.contents || '',
        });
      }

      offset += limit;
      await sleep(500);
    }

    console.log(`✅ 帖子列表获取完成：共 ${allPosts.length} 条`);
  } catch (err) {
    console.error(`❌ 帖子列表获取失败: ${err.message}`);
    log.error('Lounge crawlPostList error', err.stack);
  }

  return allPosts;
}

// ===== 核心：抓取帖子详情 + 评论（通过 API）=====

async function crawlPostDetail(post, shouldFetchComments = true) {
  const detail = { content: '', images: [], comments: [] };

  try {
    // 1. 获取帖子详情（HTML 内容）
    const url = `${API_BASE}/community/lounge/${post.gameCode || 'Tree_Of_Savior_Neverland'}/feed/${post.id}`;
    const res = await apiGet(url);
    const content = res.data?.content;
    const feed = content?.feed || {};
    const htmlContent = feed.contents || '';

    // 用 cheerio 解析 HTML
    if (htmlContent && htmlContent.includes('<')) {
      const parsed = parseContentsHTML(htmlContent);
      detail.content = parsed.text;
      detail.images = parsed.images;
    } else if (htmlContent) {
      // 可能是 JSON 格式
      const parsed = parseContentsJSON(htmlContent);
      detail.content = parsed.text;
      detail.images = parsed.images;
    }

    // 截断过长内容
    if (detail.content.length > 5000) {
      detail.content = detail.content.substring(0, 5000) + '\n...(内容已截断)';
    }

    // 用详情页的信息补充列表信息
    if (content?.user?.nickname) post.author = content.user.nickname;

    // 2. 获取评论（只有需要时才请求）
    if (shouldFetchComments) {
      try {
        const commentUrl = `${COMMENT_API_BASE}/type/FEED/id/${post.id}/comments?limit=${LOUNGE_CONFIG.maxComments}&offset=0&orderType=ASC&originalLoungeId=${post.gameCode || 'Tree_Of_Savior_Neverland'}`;
        const commentRes = await apiGet(commentUrl);
        const commentData = commentRes.data?.content;
        const comments = commentData?.comments || [];
        for (const c of comments) {
          if (detail.comments.length >= LOUNGE_CONFIG.maxComments) break;
          detail.comments.push({
            author: c.user?.nickname || '',
            text: (c.contents || '').substring(0, 1000),
            time: parseNaverDate(c.createdDate || ''),
            likes: String(c.likeCount || 0),
          });
        }
      } catch (commentErr) {
        console.log(`  ⚠️ 帖子 #${post.id} 评论获取跳过（API 限制）`);
      }
    } else {
      console.log(`  ⏭️ 帖子 #${post.id} 跳过评论（非2天内新帖且评论数未增加）`);
    }

    console.log(`   帖子 #${post.id} 抓取完成：正文 ${detail.content.length} 字，图片 ${detail.images.length} 张，评论 ${detail.comments.length} 条`);
  } catch (err) {
    console.error(`  ❌ 帖子 #${post.id} 详情抓取失败: ${err.message}`);
  }

  return detail;
}

// ===== 排重：查询仓库里已有的帖子评论数 =====

function getExistingPosts() {
  const map = {};
  try {
    const database = db.getDb();
    if (!database) return map;
    const rows = db.queryAll('SELECT post_id, comment_count, crawled_at FROM lounge_posts');
    for (const row of rows) {
      map[row.post_id] = { commentCount: row.comment_count || 0, crawledAt: row.crawled_at || '' };
    }
  } catch (_) {}
  return map;
}

function isRecentPost(timeStr) {
  if (!timeStr) return true;
  try {
    const postDate = new Date(timeStr.replace(' ', 'T'));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    return postDate >= twoDaysAgo;
  } catch (_) {
    return true;
  }
}

// ===== 主入口：完整抓取流程 =====

async function crawlLounge(options = {}) {
  if (isCrawling) {
    console.log('⚠️ 爬虫正在运行中，跳过本次请求');
    return { success: false, error: '爬虫正在运行中' };
  }

  isCrawling = true;
  resetProgress();
  const startTime = Date.now();
  const result = { success: false, posts: [], totalPosts: 0, totalComments: 0, crawlTime: 0, skippedPosts: 0, error: null };

  try {
    console.log('\n🚀 ===== Naver Lounge 爬虫启动（API 模式）=====');
    updateProgress('starting', '启动中', '正在连接 Naver API...', { totalSteps: 4, currentStep: 1 });

    let games = LOUNGE_CONFIG.games;
    if (options.gameCode) {
      games = games.filter(g => g.code === options.gameCode);
      if (games.length === 0) throw new Error(`未找到游戏: ${options.gameCode}`);
    }

    for (const game of games) {
      console.log(`\n🎮 开始抓取: ${game.name}`);

      // 第一步：获取帖子列表
      updateProgress('list', '抓取列表', `正在获取 ${game.name} 帖子列表...`, { currentStep: 1 });
      const postList = await crawlPostList(game, options);
      if (postList.length === 0) {
        console.log(`⚠️ ${game.name} 没有抓到任何帖子`);
        continue;
      }
      updateProgress('list', '列表完成', `获取到 ${postList.length} 条帖子`, { postsFound: postList.length });

      // 第二步：排重过滤
      updateProgress('filter', '排重过滤', '正在分析帖子...', { currentStep: 2 });
      const existingMap = getExistingPosts();
      const postsToOpen = [];
      const postsToSkip = [];
      const postsBasicOnly = [];
      const maxDetail = options.maxDetail || postList.length;
      let detailCount = 0;

      for (const post of postList) {
        if (detailCount >= maxDetail) { postsBasicOnly.push(post); continue; }
        const existing = existingMap[post.id];
        const isRecent = isRecentPost(post.time);
        if (!existing) { postsToOpen.push(post); detailCount++; }
        else if (isRecent) { postsToOpen.push(post); detailCount++; }
        else if (post.commentCount > existing.commentCount) { postsToOpen.push(post); detailCount++; }
        else { postsToSkip.push(post); }
      }

      console.log(`📋 排重结果：需打开 ${postsToOpen.length} 条，跳过 ${postsToSkip.length} 条`);
      updateProgress('filter', '排重完成', `需打开 ${postsToOpen.length} 条，跳过 ${postsToSkip.length} 条`, { totalSteps: 4, currentStep: 2 });

      // 第三步：逐个获取帖子详情
      updateProgress('detail', '抓取详情', `开始抓取 ${postsToOpen.length} 条帖子详情...`, { currentStep: 3, totalSteps: 3 + postsToOpen.length });
      for (let i = 0; i < postsToOpen.length; i++) {
        const post = postsToOpen[i];
        console.log(`  [${i + 1}/${postsToOpen.length}] 正在抓取: ${post.title.substring(0, 30)}...`);
        updateProgress('detail', '抓取详情', `[${i + 1}/${postsToOpen.length}] ${post.title.substring(0, 40)}...`, { currentStep: 3 + i, postsCrawled: i });

        // 决定是否翻评论：2天内的新帖子 或 评论数增加了的旧帖子
        const existing = existingMap[post.id];
        const isRecent = isRecentPost(post.time);
        const commentIncreased = existing && post.commentCount > existing.commentCount;
        const shouldFetchComments = isRecent || commentIncreased || !existing;

        // 对于列表里已有 JSON contents 的帖子，先尝试直接解析
        let detail;
        if (post._contentsJSON && post._contentsJSON.startsWith('{')) {
          const parsed = parseContentsJSON(post._contentsJSON);
          if (parsed.text.length > 20) {
            // 列表 JSON 已够用，不需要再请求详情 API
            detail = { content: parsed.text, images: parsed.images, comments: [] };
            // 只有需要时才获取评论
            if (shouldFetchComments) {
              try {
                const commentUrl = `${COMMENT_API_BASE}/type/FEED/id/${post.id}/comments?limit=${LOUNGE_CONFIG.maxComments}&offset=0&orderType=ASC&originalLoungeId=${game.code}`;
                const commentRes = await apiGet(commentUrl);
                const comments = commentRes.data?.content?.comments || [];
                for (const c of comments) {
                  if (detail.comments.length >= LOUNGE_CONFIG.maxComments) break;
                  detail.comments.push({
                    author: c.user?.nickname || '',
                    text: (c.contents || '').substring(0, 1000),
                    time: parseNaverDate(c.createdDate || ''),
                    likes: String(c.likeCount || 0),
                  });
                }
              } catch (_) {}
            } else {
              console.log(`  ⏭️ 帖子 #${post.id} 跳过评论（非2天内新帖且评论数未增加）`);
            }
            console.log(`  📄 帖子 #${post.id} 从列表JSON解析：正文 ${detail.content.length} 字，评论 ${detail.comments.length} 条`);
          }
        }

        if (!detail) {
          detail = await crawlPostDetail({ ...post, gameCode: game.code }, shouldFetchComments);
        }

        result.posts.push({
          ...post,
          gameCode: game.code,
          gameName: game.name,
          content: detail.content,
          images: detail.images,
          comments: detail.comments,
          crawledAt: fmtCST8(new Date()),
        });
        result.totalComments += detail.comments.length;

        if (i < postsToOpen.length - 1) await sleep(LOUNGE_CONFIG.delayBetween);
      }

      result.totalPosts += postList.length;
      result.skippedPosts += postsToSkip.length;

      for (const post of postsBasicOnly) {
        const parsed = post._contentsJSON ? parseContentsJSON(post._contentsJSON) : { text: '', images: [] };
        result.posts.push({
          ...post,
          gameCode: game.code,
          gameName: game.name,
          content: parsed.text,
          images: parsed.images,
          comments: [],
          crawledAt: fmtCST8(new Date()),
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
      currentStep: 100, totalSteps: 100, postsCrawled: result.posts.length, commentsFound: result.totalComments,
    });
  } catch (err) {
    result.error = err.message;
    console.error(`\n❌ 爬虫执行失败: ${err.message}`);
    updateProgress('error', '抓取失败', err.message, { currentStep: 100, totalSteps: 100 });
    log.error('Lounge crawl error', err.stack);
  } finally {
    isCrawling = false;
    lastCrawlTime = fmtCST8(new Date());
    lastCrawlResult = { success: result.success, postCount: result.posts.length, commentCount: result.totalComments, crawlTime: result.crawlTime, error: result.error };
  }

  return result;
}

// ===== 单帖重爬 =====

async function recrawlPost(postId) {
  const post = db.queryOne('SELECT * FROM lounge_posts WHERE post_id = ?', [postId]);
  if (!post) return { success: false, message: '帖子不存在' };
  if (!post.url) return { success: false, message: '帖子无URL，无法重爬' };

  try {
    const detail = await crawlPostDetail({ id: postId, url: post.url, gameCode: post.game_code });

    if (detail.content) {
      db.getDb().run(`UPDATE lounge_posts SET content = ?, images = ? WHERE post_id = ?`,
        [detail.content, JSON.stringify(detail.images || []), postId]);
    }
    db.getDb().run('DELETE FROM lounge_comments WHERE post_id = ?', [postId]);
    for (const comment of (detail.comments || [])) {
      db.getDb().run(
        `INSERT INTO lounge_comments (post_id, game_code, author, content, comment_time, likes, crawled_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now','+8 hours'))`,
        [postId, post.game_code, comment.author, comment.text, comment.time, parseInt(comment.likes) || 0]);
    }
    db.saveDb();

    console.log(`  [重爬] 帖子 ${postId} 更新完成：评论 ${detail.comments?.length || 0} 条`);
    return { success: true, message: '重爬完成', detail: { content: detail.content?.substring(0, 100), comments: detail.comments?.length || 0 } };
  } catch (e) {
    console.error(`  [重爬] 帖子 ${postId} 失败:`, e.message);
    return { success: false, message: e.message };
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

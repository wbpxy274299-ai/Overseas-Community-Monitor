/**
 * 舆情监控定时任务调度器
 * 基于分钟级检查的可靠调度（避免 setTimeout+setInterval 漂移）
 * 支持启动补跑、并发保护
 */

const sentiment = require('./sentiment');
const weeklyReport = require('./weekly_report');
const log = require('./logger');
const db = require('./db');
const { CHANNELS } = require('./config');

// 韩国社区抓取模块（可选，如果 routes/lounge.js 存在）
let loungeModule = null;
try { loungeModule = require('./routes/lounge'); } catch (_) {}

let schedulerInterval = null;
const path = require('path');
const fs = require('fs');

// 打个比方：lastRunDates 就像调度器的「工作日志」
// 以前写在脑子里（内存），一重启就忘了。现在写到笔记本上（文件），重启后翻开笔记本就知道今天干了什么
const STATE_FILE = path.join(__dirname, '.scheduler_state.json');

// 任务执行状态记录（状态面板用）
const taskRunLog = {
  dailyAnalysis: { lastRun: null, success: false, message: '' },
  dailySnapshot: { lastRun: null, success: false, message: '' },
  midnightCollect: { lastRun: null, success: false, message: '' },
  afternoonBackup: { lastRun: null, success: false, message: '' },
  loungeCrawl: { lastRun: null, success: false, message: '' },
  loungeCrawlMorning: { lastRun: null, success: false, message: '' },
  loungeWatchdog: { lastRun: null, success: false, message: '' },
};

// 从文件读取状态（重启后恢复）
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      console.log('📂 调度器状态已从文件恢复');
      return data;
    }
  } catch (e) {
    console.warn('⚠️ 调度器状态文件读取失败，使用默认值');
  }
  return { dailyAnalysis: null, dailySnapshot: null, midnightCollect: null, afternoonBackup: null, loungeCrawl: null, loungeCrawlMorning: null, loungeCrawlEvening: null, loungeWatchdogCheck: null };
}

// 状态写入文件（持久化）
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(lastRunDates, null, 2), 'utf-8');
  } catch (e) {
    console.warn('⚠️ 调度器状态保存失败:', e.message);
  }
}

let lastRunDates = loadState();

// 重试节流：失败后每 30 分钟才重试一次，避免代理挂的时候每分钟刷屏
let lastAnalysisRetryTime = 0;
const RETRY_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
let analysisRetryCount = 0; // 当日重试计数器

// 采集锁卡死检测：记录发现锁住的时间，超过 30 分钟自动解锁
let collectLockDetectedAt = null;
const COLLECT_LOCK_TIMEOUT = 30 * 60 * 1000; // 30 分钟

// 获取任务执行日志（状态面板用）
function getTaskRunLog() { return taskRunLog; }

/**
 * 计算距离目标时间的毫秒数
 * @param {string} targetTime - 时间字符串，支持格式: "2026-06-16T15:16" 或 "2026-06-16 15:16"
 * @returns {number} 距离目标时间的毫秒数（负数表示已过期）
 */
function getTimeToTarget(targetTime) {
  if (!targetTime || targetTime.trim() === '') {
    console.log('⚠️ send_time 为空，立即执行');
    return -1; // 无效时间，立即执行
  }
  
  const now = new Date();
  
  // 标准化时间格式：将空格替换为T，确保ISO格式
  const normalizedTime = targetTime.trim().replace(' ', 'T');
  const target = new Date(normalizedTime);
  
  // 如果解析失败
  if (isNaN(target.getTime())) {
    console.error(`⚠️ 时间解析失败: ${targetTime} (标准化后: ${normalizedTime})`);
    return -1;
  }
  
  const delay = target.getTime() - now.getTime();
  
  // 输出调试信息
  console.log(`🕐 时间检查:`);
  console.log(`   目标时间: ${targetTime} → ${normalizedTime}`);
  console.log(`   解析结果: ${target.toLocaleString('zh-CN')} (${target.toISOString()})`);
  console.log(`   当前时间: ${now.toLocaleString('zh-CN')} (${now.toISOString()})`);
  console.log(`   时间差: ${delay}ms (${Math.round(delay/1000)}秒 / ${Math.round(delay/3600000)}小时)`);
  
  return delay;
}

/**
 * 执行单个定时任务
 * @param {Object} task - 任务对象
 */
async function executeScheduledTask(task) {
  console.log(`\n🕐 定时任务触发：#${task.id} [${task.channel_name}]`);
  log.info(`定时任务执行: #${task.id} [${task.channel_name}]`);
  
  try {
    // 更新状态为执行中
    db.updateTask(task.id, { status: 'sending' });
    
    // 根据频道名称判断是Twitter还是Discord采集
    const channelName = task.channel_name.toLowerCase();
    let records = [];
    
    if (channelName.includes('twitter') || channelName.includes('yahoo')) {
      // Twitter/Yahoo采集
      console.log('🐦 采集 Twitter 数据...');
      records = await sentiment.collectFromTwitter();
      console.log(`✅ Twitter 采集完成: ${records.length} 条`);
    } else if (channelName.includes('discord')) {
      // Discord采集
      console.log('💬 采集 Discord 数据...');
      records = await sentiment.collectFromDiscord();
      console.log(`✅ Discord 采集完成: ${records.length} 条`);
    } else {
      // 默认同时采集
      console.log('🐦 采集 Twitter 数据...');
      const twitterRecords = await sentiment.collectFromTwitter();
      console.log(`✅ Twitter 采集完成: ${twitterRecords.length} 条`);
      
      console.log('💬 采集 Discord 数据...');
      const discordRecords = await sentiment.collectFromDiscord();
      console.log(`✅ Discord 采集完成: ${discordRecords.length} 条`);
      
      records = [...twitterRecords, ...discordRecords];
    }
    
    // 保存到数据库
    if (records.length > 0) {
      const result = await sentiment.batchSaveRecords(records);
      console.log(`✅ 保存完成: 新增 ${result.success} 条，跳过 ${result.failed} 条`);
      log.info(`定时任务 #${task.id} 完成: 新增 ${result.success} 条，跳过 ${result.failed} 条`);
      
      db.updateTask(task.id, {
        status: 'sent',
        actual_time: db.nowStr(),
        content: `采集成功: 新增 ${result.success} 条`
      });
    } else {
      console.log('⚠️ 未采集到新数据');
      log.info(`定时任务 #${task.id} 完成: 未采集到新数据`);
      
      db.updateTask(task.id, {
        status: 'sent',
        actual_time: db.nowStr(),
        content: '采集完成但未获取到新数据'
      });
    }
    
    // 生成并保存周报（如果是日报/周报任务）
    if (task.channel_name.includes('日报') || task.channel_name.includes('周报')) {
      console.log('📊 生成报告...');
      const reportResult = await weeklyReport.generateWeeklyReport();
      if (reportResult.success) {
        console.log('✅ 报告生成成功');
      }
    }
    
  } catch (e) {
    console.error(`❌ 定时任务 #${task.id} 执行失败:`, e.message);
    console.error(e.stack);
    log.error(`定时任务 #${task.id} 执行失败`, e.message);
    
    db.updateTask(task.id, {
      status: 'failed',
      fail_reason: e.message
    });
  }
}

/**
 * 获取今天的日期字符串 YYYY-MM-DD
 */
function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

/**
 * 检查并执行到期的定时任务（仅舆情采集任务，排除 DC 发布任务）
 * DC 发布任务由 scanner.js 的 runScan() 负责，这里不碰
 */
async function checkAndExecuteTasks() {
  try {
    // 构建 DC 发布频道排除列表（这些任务由扫描器处理，调度器不碰）
    const dcChannelNames = Object.keys(CHANNELS);
    const placeholders = dcChannelNames.map(() => '?').join(',');
    
    const tasks = db.queryAll(
      `SELECT * FROM tasks WHERE status = 'scheduled' AND channel_name NOT IN (${placeholders}) ORDER BY send_time ASC`,
      dcChannelNames
    );
    
    if (tasks.length === 0) return;
    
    const now = new Date();
    
    for (const task of tasks) {
      const delay = getTimeToTarget(task.send_time);
      
      if (delay <= 0) {
        if (delay < -3600000) {
          console.log(`⚠️ 任务 #${task.id} 已过期超过1小时，标记为失败`);
          db.updateTask(task.id, { status: 'failed', fail_reason: `定时时间已过期: ${task.send_time}` });
          continue;
        }
        console.log(`✅ 任务 #${task.id} 到期，开始执行...`);
        executeScheduledTask(task).catch(err => {
          console.error(`任务 #${task.id} 执行异常:`, err.message);
        });
      }
    }
  } catch (e) {
    console.error('❌ 检查定时任务失败:', e.message);
    log.error('检查定时任务失败', e.message);
  }
}

// ===== 删除重复报告生成代码，统一使用 weekly_report.js =====

/**
 * 启动健康自检（调度器启动时调用）
 * 比喻：每天早上开工前先检查一遍工具和设备是否正常
 */
function startupHealthCheck() {
  console.log('\n🏥 ===== 启动健康自检 =====');
  const today = todayStr();
  const now = new Date();

  // 1. 检查韩国社区数据新鲜度
  if (loungeModule && loungeModule.fullCrawlPipeline) {
    try {
      const latestPost = db.queryOne(`SELECT crawled_at FROM lounge_posts ORDER BY crawled_at DESC LIMIT 1`);
      if (!latestPost || !latestPost.crawled_at) {
        console.log('  🇰🇷 韩国数据: 空数据库，将在1分钟内触发首次抓取');
        // 1分钟后触发（给数据库初始化时间）
        setTimeout(() => loungeFreshnessCheck(), 60000);
      } else {
        const hoursSince = (Date.now() - new Date(latestPost.crawled_at).getTime()) / (1000 * 60 * 60);
        if (hoursSince > 24) {
          console.log(`  🇰🇷 韩国数据: ⚠️ 已 ${hoursSince.toFixed(1)} 小时未更新，将在1分钟内触发补抓`);
          setTimeout(() => loungeFreshnessCheck(), 60000);
        } else {
          console.log(`  🇰🇷 韩国数据: ✅ 正常（${hoursSince.toFixed(1)} 小时前更新）`);
        }
      }
    } catch (e) {
      console.warn(`  🇰🇷 韩国数据: 检查异常 - ${e.message}`);
    }
  }

  // 2. 检查今日任务完成情况
  const tasksDone = [
    lastRunDates.dailyAnalysis === today ? '✅每日分析' : '⬜每日分析',
    lastRunDates.midnightCollect === today ? '✅零点采集' : '⬜零点采集',
    lastRunDates.dailySnapshot === today ? '✅快照保存' : '⬜快照保存',
  ].join(' | ');
  console.log(`  📊 今日任务: ${tasksDone}`);

  console.log('🏥 ===== 自检完成 =====\n');
}

/**
 * 启动定时任务调度器
 * 每分钟检查一次是否有到期的任务
 */
function startScheduler() {
  if (schedulerInterval) {
    console.log('⚠️ 定时任务调度器已经在运行中');
    return;
  }
  
  console.log('\n🕐 舆情监控定时任务调度器已启动');
  console.log('   检查频率: 每1分钟检查一次\n');
  log.info('舆情监控定时任务调度器已启动');

  // ★ 启动时立即做一次健康自检
  startupHealthCheck();
  
  // 立即检查一次定时发送任务
  checkAndExecuteTasks();
  
  // 每分钟检查一次
  schedulerInterval = setInterval(() => {
    checkAndExecuteTasks();
    checkScheduledJobs();
  }, 60000);
  
  // 启动后立即检查一次定时任务（支持启动补跑）
  checkScheduledJobs();
}

/**
 * 检查定时任务（每分钟调用，支持启动补跑）
 */
function checkScheduledJobs() {
  const now = new Date();
  const today = todayStr();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // ★ 采集锁卡死保护：就像厨房门锁了30分钟还没人出来，自动撬锁
  if (sentiment.getIsCollecting()) {
    if (!collectLockDetectedAt) {
      collectLockDetectedAt = Date.now();
      console.log('🔒 检测到采集锁已上锁，开始计时...');
    } else if (Date.now() - collectLockDetectedAt > COLLECT_LOCK_TIMEOUT) {
      console.log('⚠️ 采集锁已卡死超过30分钟，强制解锁！');
      sentiment.setIsCollecting(false);
      collectLockDetectedAt = null;
      sentiment.recordError('调度器-锁卡死', '采集锁卡死超过30分钟，已自动解锁');
    }
  } else {
    collectLockDetectedAt = null; // 锁已正常释放，重置计时
  }
  
  // 1. 每日 8:30 热门话题分析（启动补跑：已过 8:30 但今天未跑）
  // ★ 修复：先干活，成功了再打卡；失败了下一轮还能重试
  // ★ 节流：失败后每 30 分钟重试一次，不刷屏
  if (lastRunDates.dailyAnalysis !== today) {
    // 新的一天，重置重试计数器
    if (analysisRetryCount > 0) { analysisRetryCount = 0; }
    const timeSinceLastRetry = Date.now() - lastAnalysisRetryTime;
    const canRetry = lastAnalysisRetryTime === 0 || timeSinceLastRetry >= RETRY_INTERVAL_MS;
    if ((currentHour > 8 || (currentHour === 8 && currentMinute >= 30)) && canRetry) {
      lastAnalysisRetryTime = Date.now();
      console.log('⏰ 触发每日热门话题分析（补跑/定时）');
      dailyAnalysisTask().then((result) => {
        const topicCount = (result.twitter || 0) + (result.discord || 0);
        if (result.success && topicCount > 0) {
          // 有话题产生 → 标记完成
          lastRunDates.dailyAnalysis = today;
          saveState();
          taskRunLog.dailyAnalysis = { lastRun: new Date().toISOString(), success: true, message: `${topicCount} 个话题` };
          console.log(`✅ 每日分析成功: ${topicCount} 个话题，已标记完成`);
        } else if (result.success && result.message === '无数据') {
          // 时间窗口内没有高质量数据 → 也标记完成，别死循环
          lastRunDates.dailyAnalysis = today;
          saveState();
          taskRunLog.dailyAnalysis = { lastRun: new Date().toISOString(), success: false, message: '时间窗口内无高质量数据' };
          console.log('⚠️ 每日分析: 时间窗口内无高质量数据(content_quality≥2)，已标记完成不再重试');
          console.log('   💡 提示: 检查 sentiment_records 表中 created_at 在昨日8:30~今日8:30 之间且 content_quality≥2 的记录数');
        } else if (result.success && topicCount === 0) {
          // AI 分析完成但没产出话题（AI 返回空结果）→ 重试次数+1，超过3次就放弃
          analysisRetryCount++;
          taskRunLog.dailyAnalysis = { lastRun: new Date().toISOString(), success: false, message: `AI返回0话题(重试${analysisRetryCount}/3)` };
          if (analysisRetryCount >= 3) {
            lastRunDates.dailyAnalysis = today;
            saveState();
            console.log('⚠️ 每日分析: AI连续3次返回0话题，今日不再重试');
          } else {
            console.log(`⚠️ 每日分析: AI返回0话题，30分钟后重试(${analysisRetryCount}/3)`);
          }
        } else {
          // 真正的失败（采集异常、AI API报错等）→ 允许重试
          analysisRetryCount++;
          taskRunLog.dailyAnalysis = { lastRun: new Date().toISOString(), success: false, message: result?.message || '未知错误' };
          if (analysisRetryCount >= 5) {
            lastRunDates.dailyAnalysis = today;
            saveState();
            console.log(`❌ 每日分析: 连续失败${analysisRetryCount}次，今日放弃: ${result?.message}`);
          } else {
            console.log(`❌ 每日分析失败(重试${analysisRetryCount}/5)，30分钟后再试: ${result?.message}`);
          }
        }
      }).catch(e => {
        analysisRetryCount++;
        taskRunLog.dailyAnalysis = { lastRun: new Date().toISOString(), success: false, message: e.message };
        sentiment.recordError('调度器-每日分析', e.message);
        if (analysisRetryCount >= 5) {
          lastRunDates.dailyAnalysis = today;
          saveState();
          console.error(`❌ 每日分析异常${analysisRetryCount}次，今日放弃:`, e.message);
        } else {
          console.error(`❌ 每日分析异常(重试${analysisRetryCount}/5):`, e.message);
        }
      });
    }
  }
  
  // 2. 每日舆情快照保存（安全网：10:00后如果还没存，自动存一份）
  //    主触发点在 dailyAnalysisTask 分析完成后自动调，这里只是保险
  if (lastRunDates.dailySnapshot !== today) {
    if (currentHour >= 10) {
      if (sentiment.getIsCollecting()) {
        console.log('⏳ 采集进行中，快照等待下一轮...');
      } else {
        console.log('⏰ 触发每日舆情快照保存（保险补跑）');
        lastRunDates.dailySnapshot = today;
        saveState();
        saveDailySnapshotTask().then(() => {
          taskRunLog.dailySnapshot = { lastRun: new Date().toISOString(), success: true, message: '完成' };
        }).catch(e => {
          taskRunLog.dailySnapshot = { lastRun: new Date().toISOString(), success: false, message: e.message };
          sentiment.recordError('调度器-快照', e.message);
          console.error('❌ 快照保存失败:', e.message);
        });
      }
    }
  }
  
  // 3. 每日 0:00 全量采集（放宽到0:00~5:59，避免服务器重启错过）
  if (lastRunDates.midnightCollect !== today) {
    if (currentHour < 6 && !sentiment.getIsCollecting()) {
      console.log('⏰ 触发每日零点全量采集');
      lastRunDates.midnightCollect = today;
      saveState();  // 持久化
      midnightFullCollectTask().then(() => {
        taskRunLog.midnightCollect = { lastRun: new Date().toISOString(), success: true, message: '完成' };
      }).catch(e => {
        taskRunLog.midnightCollect = { lastRun: new Date().toISOString(), success: false, message: e.message };
        sentiment.recordError('调度器-零点采集', e.message);
        console.error('❌ 零点采集失败:', e.message);
      });
    }
  }

  // 4. ★ 下午 14:00 备份采集（安全网：如果上午采集都失败了，下午再补一次）
  // 打个比方：上午的课没赶上，下午还有个补课机会
  if (lastRunDates.afternoonBackup !== today) {
    if (currentHour >= 14 && currentHour < 18 && !sentiment.getIsCollecting()) {
      // 检查今天是否已经有足够数据（如果8:30分析成功了就不用补）
      const todayTopics = sentiment.getTodayHotTopics();
      const hasTopics = todayTopics && ((todayTopics.twitter_topics?.length || 0) + (todayTopics.discord_topics?.length || 0) > 0);
      
      if (!hasTopics) {
        console.log('⏰ 触发下午备份采集（上午数据不足，补货）');
        lastRunDates.afternoonBackup = today;
        saveState();
        afternoonBackupTask().then((result) => {
          taskRunLog.afternoonBackup = { lastRun: new Date().toISOString(), success: result?.success || false, message: result?.message || '完成' };
        }).catch(e => {
          taskRunLog.afternoonBackup = { lastRun: new Date().toISOString(), success: false, message: e.message };
          sentiment.recordError('调度器-下午备份', e.message);
          console.error('❌ 下午备份采集失败:', e.message);
        });
      } else {
        // 数据充足，标记跳过
        lastRunDates.afternoonBackup = today;
        saveState();
      }
    }
  }

  // 5. ★ 韩国社区早9点补抓（填补 0:00~14:00 之间的空档）
  // 比喻：凌晨的货到了但可能有问题，早上再验一次
  if (loungeModule && loungeModule.fullCrawlPipeline) {
    if (lastRunDates.loungeCrawlMorning !== today) {
      if ((currentHour === 9 || (currentHour >= 9 && currentHour < 12)) && !sentiment.getIsCollecting()) {
        console.log('⏰ 触发韩国社区早9点补抓');
        lastRunDates.loungeCrawlMorning = today;
        saveState();
        loungeCrawlTask().then((result) => {
          taskRunLog.loungeCrawlMorning = { lastRun: new Date().toISOString(), success: result?.success || false, message: result?.message || '完成' };
        }).catch(e => {
          taskRunLog.loungeCrawlMorning = { lastRun: new Date().toISOString(), success: false, message: e.message };
          console.error('❌ 韩国社区早9点抓取失败:', e.message);
        });
      }
    }
  }

  // 6. ★ 韩国社区晚间补抓（21:00~21:59）
  if (loungeModule && loungeModule.fullCrawlPipeline) {
    if (lastRunDates.loungeCrawlEvening !== today) {
      if (currentHour === 21 && !sentiment.getIsCollecting()) {
        console.log('⏰ 触发韩国社区晚间补抓');
        lastRunDates.loungeCrawlEvening = today;
        saveState();
        loungeCrawlTask().then((result) => {
          taskRunLog.loungeCrawl = { lastRun: new Date().toISOString(), success: result?.success || false, message: result?.message || '完成' };
        }).catch(e => {
          taskRunLog.loungeCrawl = { lastRun: new Date().toISOString(), success: false, message: e.message };
          sentiment.recordError('调度器-韩国抓取', e.message);
          console.error('❌ 韩国社区抓取失败:', e.message);
        });
      }
    }
  }

  // 7. ★ 数据新鲜度看门狗（每小时检查一次）
  // 比喻：保安每小时巡逻一次，看冰箱里有没有过期的食物
  // 如果韩国帖子超过 24 小时没有新抓取，自动触发补抓
  if (loungeModule && loungeModule.fullCrawlPipeline) {
    const lastWatchdogCheck = lastRunDates.loungeWatchdogCheck || '';
    const watchdogHourKey = `${today}-${currentHour}`;
    if (lastWatchdogCheck !== watchdogHourKey) {
      lastRunDates.loungeWatchdogCheck = watchdogHourKey;
      saveState();
      loungeFreshnessCheck().catch(e => {
        console.error('❌ 韩国数据新鲜度检查失败:', e.message);
      });
    }
  }
}

/**
 * 执行每日热门话题分析任务（带并发保护）
 * 
 * ★★★ 核心原则 ★★★
 * 所有舆情分析必须基于历史数据池（sentiment_records 表）按时间范围查询，
 * 绝不可以基于某次采集的中间结果来推进分析。
 * 采集和分析是独立的两个步骤：
 *   1. 采集：把数据存入数据库（补充数据池）
 *   2. 分析：从数据库按时间范围查询并分析（与本次采集无关）
 */
async function dailyAnalysisTask() {
  if (sentiment.getIsCollecting()) {
    console.log('⚠️ 采集进行中，跳过每日分析任务');
    return { success: false, message: '采集进行中' };
  }
  
  console.log('\n🔥 ===== 开始执行每日日报任务（采集 + 分析）=====');
  
  let taskResult = { success: false, message: '未完成' };
  try {
    sentiment.setIsCollecting(true);
    
    // 第一步：采集最新数据
    console.log('📥 第一步：采集昨日8:30~今日8:30的数据...');
    const twitterData = await sentiment.collectFromTwitter();
    console.log(`   🐦 Twitter: ${twitterData.length} 条`);
    const discordData = await sentiment.collectFromDiscord();
    console.log(`   💬 Discord: ${discordData.length} 条`);
    
    const allData = [...twitterData, ...discordData];
    if (allData.length > 0) {
      const saved = await sentiment.batchSaveRecords(allData, true); // 启用 AI 情感分析
      console.log(`   ✅ 保存: 新增 ${saved.saved || saved.success || 0} 条, 跳过 ${saved.skipped || saved.failed || 0} 条`);
    }
    
    // 第二步：AI 分析热门话题
    // ★ 核心原则：分析基于历史数据池（数据库）按时间范围查询，与本次采集结果无关
    console.log('\n🤖 第二步：从历史数据池分析热门话题（昨日8:30~今日8:30）...');
    const result = await sentiment.runDailyHotTopicsAnalysis();
    
    if (result.success) {
      console.log(`✅ 每日日报任务完成`);
      console.log(`   Twitter: ${result.twitter || 0} 个话题`);
      console.log(`   Discord: ${result.discord || 0} 个话题`);
      console.log(`   韩国: ${result.lounge || 0} 个话题`);
      taskResult = { success: true, twitter: result.twitter || 0, discord: result.discord || 0, lounge: result.lounge || 0 };
    } else {
      console.error('❌ 分析失败:', result.message || result.error);
      taskResult = { success: false, message: result.message || result.error };
    }
    
    // 第三步：回填缺失的 AI 情感分析
    console.log('\n🔄 第三步：回填缺失的 AI 情感分析...');
    await sentiment.backfillAISentiment();

    // 第四步：韩国社区数据统计（纳入日报）
    if (loungeModule && loungeModule.fullCrawlPipeline) {
      console.log('\n🇰🇷 第四步：检查韩国社区数据...');
      try {
        const loungeStats = loungeModule.getTodayStats ? loungeModule.getTodayStats() : null;
        if (loungeStats) {
          console.log(`   韩国帖子: ${loungeStats.posts || 0} 条, 已翻译: ${loungeStats.translated || 0} 条`);
        }
        // 韩国采集已对齐到零点/14:00，8:30分析时不再额外触发爬虫
      } catch (e) {
        console.warn('   ⚠️ 韩国数据统计异常:', e.message);
      }
    }

    // 第五步：分析完成后自动存快照（不用等到9点/10点）
    if (lastRunDates.dailySnapshot !== todayStr()) {
      console.log('\n📊 第五步：分析完成，自动保存今日快照...');
      lastRunDates.dailySnapshot = todayStr();
      saveState();
      await saveDailySnapshotTask();
      taskRunLog.dailySnapshot = { lastRun: new Date().toISOString(), success: true, message: '分析后自动保存' };
    }
  } catch (e) {
    console.error('❌ 每日日报任务异常:', e.message);
    console.error(e.stack);
    taskResult = { success: false, message: e.message };
  } finally {
    sentiment.setIsCollecting(false);
  }
  
  console.log('🔥 ===== 每日日报任务完成 =====\n');
  return taskResult;
}

/**
 * 执行每日零点全量采集任务（带并发保护）
 */
async function midnightFullCollectTask() {
  if (sentiment.getIsCollecting()) {
    console.log('⚠️ 采集进行中，跳过零点全量采集');
    return;
  }
  
  console.log('\n🌙 ===== 开始执行每日零点全量采集任务 =====');
  
  try {
    sentiment.setIsCollecting(true);
    const result = await sentiment.fullCollectAndSave();
    
    if (result.success) {
      console.log(`✅ 每日零点全量采集成功`);
      console.log(`   共采集: ${result.collected} 条`);
      console.log(`   新增: ${result.saved} 条`);
    } else {
      console.error(`❌ 每日零点全量采集失败:`, result.error);
    }
    
    // ★ 韩国社区同步采集（全平台对齐）
    if (loungeModule && loungeModule.fullCrawlPipeline) {
      console.log('\n🇰🇷 韩国社区同步采集...');
      try {
        const loungeResult = await loungeModule.fullCrawlPipeline();
        if (loungeResult?.success) {
          console.log('   ✅ 韩国社区采集完成');
        } else {
          console.warn('   ⚠️ 韩国社区采集异常:', loungeResult?.error || '');
        }
      } catch (le) {
        console.warn('   ⚠️ 韩国社区采集失败（不影响主流程）:', le.message);
      }
    }
  } catch (e) {
    console.error('❌ 每日零点全量采集任务异常:', e.message);
  } finally {
    sentiment.setIsCollecting(false);
  }
}

/**
 * 执行每日舆情快照保存任务
 */
async function saveDailySnapshotTask() {
  console.log('\n📊 ===== 开始执行每日舆情快照保存任务 =====');
  
  try {
    const result = await sentiment.saveDailySnapshot();
    
    if (result.success) {
      console.log(`✅ 每日舆情快照保存成功`);
      console.log(`   日期: ${result.date}`);
      console.log(`   记录数: ${result.count}`);
    } else {
      console.error('❌ 每日舆情快照保存失败:', result.message || result.error);
    }
  } catch (error) {
    console.error('❌ 每日舆情快照保存任务异常:', error);
  }
  
  console.log('📊 ===== 每日舆情快照保存任务完成 =====\n');
}

/**
 * 下午备份采集任务（安全网：上午没采到数据，下午补一次）
 * 打个比方：上午的货没进到，下午再跑一趟批发市场
 */
async function afternoonBackupTask() {
  if (sentiment.getIsCollecting()) {
    console.log('⚠️ 采集进行中，跳过下午备份采集');
    return { success: false, message: '采集进行中' };
  }

  console.log('\n🛡️ ===== 开始执行下午备份采集 =====');

  try {
    sentiment.setIsCollecting(true);

    // 第一步：采集数据
    console.log('📥 采集 Twitter + Discord...');
    const twitterData = await sentiment.collectFromTwitter();
    console.log(`   🐦 Twitter: ${twitterData.length} 条`);
    const discordData = await sentiment.collectFromDiscord();
    console.log(`   💬 Discord: ${discordData.length} 条`);

    const allData = [...twitterData, ...discordData];
    if (allData.length > 0) {
      const saved = await sentiment.batchSaveRecords(allData, true);
      console.log(`   ✅ 保存: 新增 ${saved.saved || saved.success || 0} 条`);
    }

    // ★ 韩国社区同步采集（全平台对齐）
    if (loungeModule && loungeModule.fullCrawlPipeline) {
      console.log('\n🇰🇷 韩国社区同步采集...');
      try {
        const loungeResult = await loungeModule.fullCrawlPipeline();
        if (loungeResult?.success) {
          console.log('   ✅ 韩国社区采集完成');
        }
      } catch (le) {
        console.warn('   ⚠️ 韩国社区采集失败（不影响主流程）:', le.message);
      }
    }

    // 第二步：AI 分析
    console.log('\n🤖 AI 分析热门话题...');
    const result = await sentiment.runDailyHotTopicsAnalysis();

    const topicCount = (result.twitter || 0) + (result.discord || 0) + (result.lounge || 0);
    if (topicCount > 0) {
      console.log(`✅ 下午备份完成: ${topicCount} 个话题（Twitter ${result.twitter||0}, Discord ${result.discord||0}, 韩国 ${result.lounge||0}）`);
      return { success: true, message: `采集 ${allData.length} 条, 生成 ${topicCount} 个话题` };
    } else {
      console.log('⚠️ 下午备份采集完成但未生成话题');
      return { success: true, message: `采集 ${allData.length} 条, 但无话题` };
    }
  } catch (e) {
    console.error('❌ 下午备份采集异常:', e.message);
    return { success: false, message: e.message };
  } finally {
    sentiment.setIsCollecting(false);
  }
}

/**
 * 韩国社区数据新鲜度检查（看门狗）
 * 比喻：保安检查冰箱里的食物有没有过期
 * 如果超过 24 小时没有新抓取，自动触发补抓
 */
async function loungeFreshnessCheck() {
  try {
    // 查询最近一条帖子的抓取时间
    const latestPost = db.queryOne(
      `SELECT crawled_at FROM lounge_posts ORDER BY crawled_at DESC LIMIT 1`
    );
    if (!latestPost || !latestPost.crawled_at) {
      console.log('🐕 看门狗: 韩国数据库为空，触发首次抓取');
      await loungeCrawlTask();
      return;
    }

    const lastCrawl = new Date(latestPost.crawled_at);
    const hoursSinceLastCrawl = (Date.now() - lastCrawl.getTime()) / (1000 * 60 * 60);

    if (hoursSinceLastCrawl > 24) {
      console.log(`🐕 看门狗: 韩国数据已 ${hoursSinceLastCrawl.toFixed(1)} 小时未更新，触发补抓！`);
      if (!sentiment.getIsCollecting()) {
        await loungeCrawlTask();
      } else {
        console.log('🐕 看门狗: 采集进行中，等待下一轮检查');
      }
    } else {
      console.log(`🐕 看门狗: 韩国数据正常（${hoursSinceLastCrawl.toFixed(1)} 小时前更新）`);
    }
  } catch (e) {
    // 数据库查询失败不影响主流程
    console.warn(`🐕 看门狗: 检查异常 - ${e.message}`);
  }
}

/**
 * 韩国社区定时抓取任务
 */
async function loungeCrawlTask() {
  if (!loungeModule || !loungeModule.fullCrawlPipeline) {
    return { success: false, message: 'lounge模块未加载' };
  }

  console.log('\n🇰🇷 ===== 开始执行韩国社区抓取任务 =====');

  try {
    const result = await loungeModule.fullCrawlPipeline();
    if (result?.success) {
      console.log(`✅ 韩国社区抓取完成`);
      return { success: true, message: '抓取完成' };
    } else {
      console.error('❌ 韩国社区抓取失败:', result?.error || '未知错误');
      return { success: false, message: result?.error || '未知错误' };
    }
  } catch (e) {
    console.error('❌ 韩国社区抓取异常:', e.message);
    return { success: false, message: e.message };
  }

  console.log('🇰🇷 ===== 韩国社区抓取任务完成 =====\n');
}

/**
 * 停止定时任务调度器
 */
function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('🛑 定时任务调度器已停止');
    log.info('定时任务调度器已停止');
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  executeScheduledTask,
  checkAndExecuteTasks,
  getTaskRunLog,  // 状态面板用
};

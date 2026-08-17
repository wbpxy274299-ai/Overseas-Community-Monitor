/**
 * 周报生成模块
 * 从数据库查询上周数据，生成舆情监测报告
 * 数据来源：Twitter（Yahoo实时搜索）+ Discord（繁中服）+ Naver Lounge（韩服）
 * 不调用 AI，纯数据驱动
 */

const db = require('./db');
const aiAnalyzer = require('./ai_analyzer');
const { fmtCST8 } = require('./config');

// ★ 日期格式统一使用 config.js 的 fmtCST8（不再重复定义 toLocalStr）

function getLastWeekRange() {
  // ★ 服务器已设 TZ=Asia/Shanghai，直接用本地方法
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - daysSinceMonday - 7);
  lastMonday.setHours(0, 0, 0, 0);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  lastSunday.setHours(23, 59, 59, 999);
  return {
    start: fmtCST8(lastMonday),
    end: fmtCST8(lastSunday),
    startDate: lastMonday,
    endDate: lastSunday
  };
}

// ===== 数据获取 =====

async function getWeeklyData() {
  console.log('📊 查询上周舆情数据...');

  try {
    // 使用上周时间范围（周一~周日）
    const dateRange = getLastWeekRange();
    console.log(`   📅 上周范围: ${dateRange.start.substring(0,10)} 至 ${dateRange.end.substring(0,10)}`);

    // 直接用带日期条件的 SQL 查询，不再加载全量数据到内存
    // ★ 剔除官方账号（日服官方推/繁中小梅），官方发言不计入周报
    const weeklyRecords = db.queryAll(`
      SELECT * FROM sentiment_records 
      WHERE is_noise = 0 
        AND author NOT IN ('小梅', 'ツリーオブセイヴァー：ネバーランド')
        AND created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC
    `, [dateRange.start, dateRange.end]);
    console.log(`   📦 从数据库读取到 ${weeklyRecords.length} 条上周记录`);

    if (weeklyRecords.length === 0) {
      console.warn('   ⚠️ 上周无数据');
      return { dateRange, stats: null, totalRecords: 0 };
    }

    // 只统计 Twitter 和 Discord 繁中服
    // 查询韩服 lounge_posts
    let loungePosts = [];
    try {
      loungePosts = db.queryAll(`
        SELECT * FROM lounge_posts
        WHERE crawled_at >= ? AND crawled_at <= ?
          AND author NOT IN ('GM 티메이', 'GM티메이')
        ORDER BY crawled_at DESC
      `, [dateRange.start, dateRange.end]);
      console.log(`   📦 韩服 lounge_posts: ${loungePosts.length} 条`);
    } catch (e) {
      console.warn('   ⚠️ lounge_posts 查询失败:', e.message);
    }

    const stats = {
      twitter: { total: 0, positive: 0, neutral: 0, negative: 0, records: [] },
      discord_tc: { total: 0, positive: 0, neutral: 0, negative: 0, records: [] },
      lounge_kr: { total: 0, positive: 0, neutral: 0, negative: 0, records: [] }
    };

    for (const record of weeklyRecords) {
      const sent = record.sentiment || 'neutral';
      const bucket = sent === 'positive' ? 'positive' : sent === 'negative' ? 'negative' : 'neutral';

      if (record.platform === 'twitter') {
        stats.twitter.total++;
        stats.twitter[bucket]++;
        stats.twitter.records.push(record);
      } else if (record.platform === 'discord') {
        const isJapanese = /[\u3040-\u309f\u30a0-\u30ff]/.test(record.content);
        if (!isJapanese) {
          stats.discord_tc.total++;
          stats.discord_tc[bucket]++;
          stats.discord_tc.records.push(record);
        }
      }
    }

    // 韩服数据统计
    for (const post of loungePosts) {
      const sent = post.sentiment || 'neutral';
      const bucket = sent === 'positive' ? 'positive' : sent === 'negative' ? 'negative' : 'neutral';
      stats.lounge_kr.total++;
      stats.lounge_kr[bucket]++;
      stats.lounge_kr.records.push(post);
    }

    const totalRecords = stats.twitter.total + stats.discord_tc.total + stats.lounge_kr.total;
    return { dateRange, stats, totalRecords };
  } catch (error) {
    console.error('❌ 获取周报数据失败:', error);
    throw error;
  }
}

// ===== 热门话题提取（增强版：包含详细统计和样本）=====

const TAG_LABELS = {
  bug_report: 'Bug/问题', gacha: '抽卡/氪金', knight_order: '骑士团/公会',
  tree_bond: '树缘系统', event: '活动/狂潮', cosmetic: '时装/外观',
  world_boss: '世界Boss', photo: '拍照模式', pricing: '充值/定价',
  server: '服务器/网络', general: '其他讨论'
};

function extractTopicsByTag(records, topN = 5, dateRange = null) {
  const tagCounts = {};
  for (const record of records) {
    const tag = record.topic_tag || 'general';
    if (!tagCounts[tag]) tagCounts[tag] = { 
      count: 0, 
      positives: 0,
      negatives: 0, 
      neutrals: 0,
      samples: [],
      urls: []
    };
    tagCounts[tag].count++;
    if (record.sentiment === 'positive') tagCounts[tag].positives++;
    else if (record.sentiment === 'negative') tagCounts[tag].negatives++;
    else tagCounts[tag].neutrals++;
    
    // 收集样本发言(优先有翻译的，只保留翻译和链接)
    if (tagCounts[tag].samples.length < 3) {
      const text = record.translated_content || record.content || '';
      if (text && text.length > 10) {
        tagCounts[tag].samples.push({
          translation: text.substring(0, 200),
          url: record.url || '#',
          sentiment: record.sentiment || 'neutral',
          created_at: record.created_at
        });
      }
    }
  }
  
  // 调试：打印所有话题分布
  console.log(`   🔍 话题分布 (${records.length} 条记录):`);
  Object.entries(tagCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([tag, data]) => {
      console.log(`      ${TAG_LABELS[tag] || tag}: ${data.count} 条 (正面 ${data.positives}, 负面 ${data.negatives})`);
    });
  
  return Object.entries(tagCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN)
    .map(([tag, data]) => {
      // 生成情绪风向描述
      const negRatio = data.count > 0 ? data.negatives / data.count : 0;
      const posRatio = data.count > 0 ? data.positives / data.count : 0;
      let emotionDesc = '';
      if (negRatio > 0.6) emotionDesc = '😟 强烈不满 - 玩家普遍表达愤怒和失望';
      else if (negRatio > 0.4) emotionDesc = '😕 偏负面 - 较多抱怨和批评声音';
      else if (posRatio > 0.5) emotionDesc = '😊 偏正面 - 玩家整体较为满意';
      else if (posRatio > 0.3) emotionDesc = '🙂 略偏正面 - 正面声音稍多';
      else emotionDesc = '😐 情绪分化 - 正负面观点并存';
      
      // 从 topic_history 获取 AI 生成的摘要
      // 优先查上周日期范围，查不到就放宽到最近可用记录
      let summary = '';
      if (dateRange) {
        try {
          let rows = db.queryAll(
            `SELECT summary FROM topic_history WHERE topic_tag = ? AND created_at >= ? AND created_at <= ? AND summary IS NOT NULL AND summary != '' ORDER BY id DESC LIMIT 1`,
            [tag, dateRange.start, dateRange.end]
          );
          if (rows.length === 0) {
            // 上周没有 → 查最近 30 天内该话题的最新摘要
            rows = db.queryAll(
              `SELECT summary FROM topic_history WHERE topic_tag = ? AND summary IS NOT NULL AND summary != '' ORDER BY id DESC LIMIT 1`,
              [tag]
            );
          }
          if (rows.length > 0) summary = rows[0].summary;
        } catch (_) {}
      }
      
      // 如果 topic_history 里完全没有摘要，从实际记录中自动生成
      if (!summary && data.samples.length > 0) {
        const sampleTexts = data.samples.map(s => s.translation).filter(t => t && t.length > 5);
        if (sampleTexts.length > 0) {
          const first = sampleTexts[0].substring(0, 80);
          summary = sampleTexts.length > 1
            ? `玩家讨论如「${first}...」等 ${data.count} 条相关发言`
            : `玩家提及「${first}...」`;
        }
      }
      
      return {
        tag,
        label: TAG_LABELS[tag] || tag,
        count: data.count,
        positives: data.positives,
        negatives: data.negatives,
        neutrals: data.neutrals,
        emotion_desc: emotionDesc,
        summary: summary || '',
        samples: data.samples.slice(0, 2)
      };
    });
}

// ===== 韩服热门话题提取（lounge_posts 字段映射）=====

const LOUNGE_CATEGORY_LABELS = {
  bug: 'Bug/问题', suggestion: '建议/提案', complaint: '投诉/不满',
  praise: '表扬/好评', question: '提问/求助', other: '其他讨论'
};

function extractLoungeTopics(records, topN = 5, dateRange = null) {
  if (!records || records.length === 0) return [];

  // 按 ai_category 分组（韩服用 ai_category 而非 topic_tag）
  const catCounts = {};
  for (const post of records) {
    const cat = post.ai_category || 'other';
    if (!catCounts[cat]) catCounts[cat] = { count: 0, positives: 0, negatives: 0, neutrals: 0, samples: [] };
    catCounts[cat].count++;
    const sent = post.sentiment || 'neutral';
    if (sent === 'positive') catCounts[cat].positives++;
    else if (sent === 'negative') catCounts[cat].negatives++;
    else catCounts[cat].neutrals++;

    if (catCounts[cat].samples.length < 3) {
      const text = post.content_zh || post.title_zh || post.content || post.title || '';
      if (text.length > 5) {
        catCounts[cat].samples.push({
          translation: text.substring(0, 200),
          url: post.url || '#',
          sentiment: post.sentiment || 'neutral',
          created_at: post.crawled_at || post.created_at
        });
      }
    }
  }

  return Object.entries(catCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN)
    .map(([cat, data]) => {
      const label = LOUNGE_CATEGORY_LABELS[cat] || cat;
      const negRatio = data.count > 0 ? data.negatives / data.count : 0;
      const posRatio = data.count > 0 ? data.positives / data.count : 0;
      let emotionDesc = '';
      if (negRatio > 0.6) emotionDesc = '😟 强烈不满';
      else if (negRatio > 0.4) emotionDesc = '😕 偏负面';
      else if (posRatio > 0.5) emotionDesc = '😊 偏正面';
      else if (posRatio > 0.3) emotionDesc = '🙂 略偏正面';
      else emotionDesc = '😐 情绪分化';

      // 从 ai_summary 获取概述
      let summary = '';
      const withSummary = records.filter(r => (r.ai_category || 'other') === cat && r.ai_summary);
      if (withSummary.length > 0) summary = withSummary[0].ai_summary;
      if (!summary && data.samples.length > 0) {
        const first = data.samples[0].translation.substring(0, 80);
        summary = `玩家讨论「${first}」等 ${data.count} 条相关内容`;
      }

      return {
        tag: cat,
        label,
        count: data.count,
        positives: data.positives,
        negatives: data.negatives,
        neutrals: data.neutrals,
        emotion_desc: emotionDesc,
        summary,
        samples: data.samples.slice(0, 2)
      };
    });
}

// ===== 情绪 & 风险评估 =====

function calcRatio(pos, neu, neg) {
  const total = pos + neu + neg;
  if (total === 0) return { positive: 0, neutral: 0, negative: 0 };
  return {
    positive: ((pos / total) * 100).toFixed(1),
    neutral: ((neu / total) * 100).toFixed(1),
    negative: ((neg / total) * 100).toFixed(1)
  };
}

function getDominantSentiment(s) {
  // 基于正面vs负面对比，不再受中性干扰
  if (s.positive > s.negative * 2) return '😊 正面为主';
  if (s.negative > s.positive * 2) return '😟 负面为主';
  if (s.positive > s.negative) return '🙂 偏正面';
  if (s.negative > s.positive) return '😕 偏负面';
  if (s.positive === 0 && s.negative === 0) return '😐 全中性';
  return '😐 正负持平';
}

// 情绪占比条（表格内联版）：按 10 格比例显示色块，0 条就是 0 格，不再硬凑 1 格
function emoBar(count, total) {
  if (!total || total <= 0) return '';
  return '🟩'.repeat(Math.round((count / total) * 10));
}

function assessRiskLevel(stats) {
  const platforms = [stats.twitter, stats.discord_tc, stats.lounge_kr];
  for (const p of platforms) {
    if (p.total === 0) continue;
    const negRatio = p.negative / p.total;
    if (negRatio > 0.5) return '🔴 高';
    if (negRatio > 0.3) return '🟡 中';
  }
  return '🟢 低';
}

// ===== 格式化 =====

function formatTopicsTable(topics) {
  if (topics.length === 0) return '暂无数据';
  let lines = [
    '| 排名 | 话题 | 发言数 | 内容概述 | 情绪分布 | 情绪风向 |',
    '|:---:|------|:---:|------|:---:|--------|'
  ];
  topics.forEach((t, i) => {
    const sentDist = `👍${t.positives} 😐${t.neutrals} 👎${t.negatives}`;
    const desc = t.summary || '—';
    lines.push(`| ${i + 1} | **${t.label}** | ${t.count} 条 | ${desc} | ${sentDist} | ${t.emotion_desc} |`);
  });
  return lines.join('\n');
}

function formatTopicSamples(topic) {
  if (topic.samples.length === 0) return '> 暂无代表性发言';
  
  let md = '';
  topic.samples.forEach((sample, idx) => {
    const sentEmoji = sample.sentiment === 'positive' ? '👍' : sample.sentiment === 'negative' ? '👎' : '💬';
    md += `> ${sentEmoji} ${sample.translation}\n`;
    md += `> [查看原帖](${sample.url}) · ${new Date(sample.created_at).toLocaleDateString('zh-CN')}\n\n`;
  });
  
  return md.trim();
}

// ===== 运营建议（数据驱动：只说本周真实存在的问题，不出套话）=====

function generateSuggestions(stats, riskLevel, topicMap) {
  const s = [];
  const platforms = [
    { key: 'twitter', label: 'Twitter（日服）', stats: stats.twitter, topics: topicMap.twitter },
    { key: 'discord', label: 'Discord（繁中服）', stats: stats.discord_tc, topics: topicMap.discord_tc },
    { key: 'lounge', label: 'Naver Lounge（韩服）', stats: stats.lounge_kr, topics: topicMap.lounge_kr }
  ];

  // 1. 负面集中的平台：点名最烫手的负面话题，不空喊“去安抚”
  for (const p of platforms) {
    if (p.stats.total === 0) continue;
    const negRatio = p.stats.negative / p.stats.total;
    if (negRatio >= 0.3 && p.stats.negative > p.stats.positive) {
      const hotNeg = (p.topics || []).filter(t => t.negatives > 0).sort((a, b) => b.negatives - a.negatives)[0];
      s.push(`- **${p.label} 负面占比 ${Math.round(negRatio * 100)}%**${hotNeg ? `，集中在「${hotNeg.label}」（${hotNeg.negatives} 条负面）` : ''}：建议优先排查该话题的争议根源并准备官方回应`);
    }
  }

  // 2. 全平台最热的负面话题（跨平台汇总，只点名榜首）
  const allNegTopics = platforms.flatMap(p => (p.topics || []).map(t => ({ ...t, plat: p.label })))
    .filter(t => t.negatives > 0).sort((a, b) => b.negatives - a.negatives);
  if (allNegTopics.length > 0 && s.length === 0) {
    const top = allNegTopics[0];
    s.push(`- **本周负面最集中的话题：「${top.label}」**（${top.plat}，${top.negatives} 条负面）：建议运营同学重点跟进该话题下的玩家诉求`);
  }

  // 3. 讨论量明显失衡的平台（基于本周真实数据）
  const active = platforms.filter(p => p.stats.total > 0);
  if (active.length >= 2) {
    const max = active.reduce((a, b) => a.stats.total >= b.stats.total ? a : b);
    const others = active.reduce((sum, p) => sum + (p === max ? 0 : p.stats.total), 0);
    if (others > 0 && max.stats.total >= others * 2) {
      s.push(`- **${max.label} 讨论量是其他平台总和的 ${Math.floor(max.stats.total / others)} 倍以上**：本周玩家声音主要在这里，建议运营资源向该平台倾斜`);
    }
  }

  // 4. 兵底：本周确实平安才说健康，不再每周必出“持续监控”套话
  if (s.length === 0) {
    s.push('- **本周无突出负面信号**：各平台情绪平稳，可保持当前运营节奏，把精力放在新内容/活动的预热上');
  }
  return s.join('\n');
}

// ===== 总结 =====

function generateSummary(stats, totalRecords, riskLevel) {
  const totalNeg = stats.twitter.negative + stats.discord_tc.negative + stats.lounge_kr.negative;
  const totalPos = stats.twitter.positive + stats.discord_tc.positive + stats.lounge_kr.positive;
  const totalNeu = stats.twitter.neutral + stats.discord_tc.neutral + stats.lounge_kr.neutral;
  let mood = '😐 中性';
  if (totalNeg > totalPos * 1.5) mood = '😟 负面';
  else if (totalPos > totalNeg * 1.5) mood = '😊 正面';

  return `本周共收集 **${totalRecords}** 条玩家反馈，整体情绪 **${mood}**。

| 平台 | 总量 | 正面 | 中性 | 负面 |
|------|:---:|:---:|:---:|:---:|
| 🐦 Twitter | ${stats.twitter.total} | ${stats.twitter.positive} | ${stats.twitter.neutral} | ${stats.twitter.negative} |
| 💬 Discord | ${stats.discord_tc.total} | ${stats.discord_tc.positive} | ${stats.discord_tc.neutral} | ${stats.discord_tc.negative} |
| 🇰🇷 Naver | ${stats.lounge_kr.total} | ${stats.lounge_kr.positive} | ${stats.lounge_kr.neutral} | ${stats.lounge_kr.negative} |
| **合计** | **${totalRecords}** | **${totalPos}** | **${totalNeu}** | **${totalNeg}** |`;
}

// ===== 社区发言概况（只报数据事实：多少条、情绪主调、前三话题；内容解读交给 AI 分析和各章看点，不再重复）=====
function generatePlatformSummary(records, platformLabel, topTopics) {
  if (records.length === 0) return `**${platformLabel}**：本周无玩家发言。`;
  const topTags = topTopics.slice(0, 3).map(t => t.label).join('、');
  return `**${platformLabel}**（${records.length} 条发言）：话题集中在 ${topTags}，具体讨论内容见对应平台章节。`;
}

// ===== 本章看点（平台章开头一行：领导扫读用，点名最值得关注的 1~2 个话题）=====
function generatePlatformHighlight(platformStats, topics) {
  if (platformStats.total === 0 || topics.length === 0) return '';
  const parts = [];
  const hotNeg = topics.filter(t => t.negatives > 0).sort((a, b) => b.negatives - a.negatives)[0];
  const hotTalk = [...topics].sort((a, b) => b.count - a.count)[0];
  if (hotNeg) parts.push(`负面最集中在「${hotNeg.label}」（${hotNeg.negatives} 条）`);
  if (hotTalk && hotTalk !== hotNeg) parts.push(`讨论最多的是「${hotTalk.label}」（${hotTalk.count} 条）`);
  if (parts.length === 0) return '';
  return `> 📌 **本章看点**：${parts.join('；')}\n`;
}

// ===== 风险详情（第五章用：不复读等级，而是点名具体风险在哪）=====
function generateRiskDetail(stats, topicMap) {
  const platforms = [
    { label: 'Twitter（日服）', stats: stats.twitter, topics: topicMap.twitter },
    { label: 'Discord（繁中服）', stats: stats.discord_tc, topics: topicMap.discord_tc },
    { label: 'Naver Lounge（韩服）', stats: stats.lounge_kr, topics: topicMap.lounge_kr }
  ];
  const risky = platforms
    .filter(p => p.stats.total > 0)
    .map(p => ({ ...p, negRatio: p.stats.negative / p.stats.total }))
    .filter(p => p.negRatio >= 0.3)
    .sort((a, b) => b.negRatio - a.negRatio);
  if (risky.length === 0) return '本周各平台负面占比均在正常范围内，未发现集中爆发的争议点。';
  return risky.map(p => {
    const hotNeg = (p.topics || []).filter(t => t.negatives > 0).sort((a, b) => b.negatives - a.negatives)[0];
    return `- **${p.label}**：负面占比 ${Math.round(p.negRatio * 100)}%${hotNeg ? `，主要集中在「${hotNeg.label}」（${hotNeg.negatives} 条负面发言）` : ''}`;
  }).join('\n');
}

// ===== 主报告生成 =====

async function generateReport(weeklyData) {
  const { dateRange, stats, totalRecords } = weeklyData;

  // 传 dateRange 给 extractTopicsByTag，让它能查 topic_history 获取话题概述
  const twitterTopics = extractTopicsByTag(stats.twitter.records, 5, dateRange);
  const tcTopics = extractTopicsByTag(stats.discord_tc.records, 5, dateRange);
  const loungeTopics = extractLoungeTopics(stats.lounge_kr.records, 5, dateRange);

  const twRatio = calcRatio(stats.twitter.positive, stats.twitter.neutral, stats.twitter.negative);
  const tcRatio = calcRatio(stats.discord_tc.positive, stats.discord_tc.neutral, stats.discord_tc.negative);
  const lgRatio = calcRatio(stats.lounge_kr.positive, stats.lounge_kr.neutral, stats.lounge_kr.negative);
  const riskLevel = assessRiskLevel(stats);
  const summary = generateSummary(stats, totalRecords, riskLevel);

  // AI 智能分析（合并到总览中）
  let aiAnalysis = '';
  try {
    const aiStats = {
      twitter_count: stats.twitter.total,
      discord_count: stats.discord_tc.total,
      lounge_count: stats.lounge_kr.total,
      risk_level: riskLevel
    };
    const sampleFeedbacks = [
      ...stats.twitter.records.slice(0, 5).map(r => ({
        platform: 'twitter',
        content: r.translated_content || r.content,
        sentiment: r.sentiment
      })),
      ...stats.discord_tc.records.slice(0, 5).map(r => ({
        platform: 'discord',
        content: r.content,
        sentiment: r.sentiment
      })),
      ...stats.lounge_kr.records.slice(0, 5).map(r => ({
        platform: 'lounge',
        content: r.content_zh || r.title_zh || r.content || r.title,
        sentiment: r.sentiment
      }))
    ];
    aiAnalysis = await aiAnalyzer.aiGenerateSummary(aiStats, sampleFeedbacks);
    console.log('   🤖 AI 分析生成成功');
  } catch (e) {
    console.warn('   ⚠️ AI 分析调用失败，使用默认文本:', e.message);
    aiAnalysis = '本周舆情整体平稳，建议持续关注玩家反馈。';
  }

  // 各平台社区发言概况 + 本章看点
  const twSummary = generatePlatformSummary(stats.twitter.records, '🐦 Twitter（日服）', twitterTopics);
  const dcSummary = generatePlatformSummary(stats.discord_tc.records, '💬 Discord（繁中服）', tcTopics);
  const lgSummary = generatePlatformSummary(stats.lounge_kr.records, '🇰🇷 Naver Lounge（韩服）', loungeTopics);
  const twHighlight = generatePlatformHighlight(stats.twitter, twitterTopics);
  const dcHighlight = generatePlatformHighlight(stats.discord_tc, tcTopics);
  const lgHighlight = generatePlatformHighlight(stats.lounge_kr, loungeTopics);

  // 话题详情渲染辅助函数
  const renderTopicDetails = (topics) => {
    if (topics.length === 0) return '';
    return topics.map((topic, idx) => `#### 话题 ${idx + 1}：${topic.label}

**📊 发言数**：${topic.count} 条 ｜ **📈 情绪分布**：👍 ${topic.positives} · 😐 ${topic.neutrals} · 👎 ${topic.negatives} ｜ **🎯 情绪风向**：${topic.emotion_desc}

${topic.summary ? `**📝 讨论概述**：${topic.summary}\n\n` : ''}**💬 代表性发言**：

${formatTopicSamples(topic)}`).join('\n\n');
  };

  const report = `# 🎮 M2G 舆情监测周报

> 📅 报告周期：${dateRange.start.substring(0, 10)} ~ ${dateRange.end.substring(0, 10)}
> 🕐 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
> 📡 数据来源：Twitter（Yahoo实时搜索）+ Discord（繁中服）+ Naver Lounge（韩服）

---

## 📊 一、本周总览

${summary}

**风险等级**：${riskLevel}

### 🏘️ 社区发言概况

${twSummary}

${dcSummary}

${lgSummary}

### 🤖 AI 智能分析

${aiAnalysis}

---

## 🐦 二、Twitter 日服数据（${stats.twitter.total} 条）

${twHighlight}
| 情绪 | 数量 | 占比 | 可视化 |
|------|:---:|:---:|------|
| 😊 正面 | ${stats.twitter.positive} | ${twRatio.positive}% | ${emoBar(stats.twitter.positive, stats.twitter.total)} |
| 😐 中性 | ${stats.twitter.neutral} | ${twRatio.neutral}% | ${emoBar(stats.twitter.neutral, stats.twitter.total)} |
| 😟 负面 | ${stats.twitter.negative} | ${twRatio.negative}% | ${emoBar(stats.twitter.negative, stats.twitter.total)} |

**正负对比**：正面 **${stats.twitter.positive}** vs 负面 **${stats.twitter.negative}** → **${getDominantSentiment(stats.twitter)}**

### 🔥 热门话题

${formatTopicsTable(twitterTopics)}

${renderTopicDetails(twitterTopics)}

---

## 💬 三、Discord 繁中服数据（${stats.discord_tc.total} 条）

${dcHighlight}
| 情绪 | 数量 | 占比 | 可视化 |
|------|:---:|:---:|------|
| 😊 正面 | ${stats.discord_tc.positive} | ${tcRatio.positive}% | ${emoBar(stats.discord_tc.positive, stats.discord_tc.total)} |
| 😐 中性 | ${stats.discord_tc.neutral} | ${tcRatio.neutral}% | ${emoBar(stats.discord_tc.neutral, stats.discord_tc.total)} |
| 😟 负面 | ${stats.discord_tc.negative} | ${tcRatio.negative}% | ${emoBar(stats.discord_tc.negative, stats.discord_tc.total)} |

**正负对比**：正面 **${stats.discord_tc.positive}** vs 负面 **${stats.discord_tc.negative}** → **${getDominantSentiment(stats.discord_tc)}**

### 🔥 热门话题

${formatTopicsTable(tcTopics)}

${renderTopicDetails(tcTopics)}

---

## 🇰🇷 四、Naver Lounge 韩服数据（${stats.lounge_kr.total} 条）

${lgHighlight}
| 情绪 | 数量 | 占比 | 可视化 |
|------|:---:|:---:|------|
| 😊 正面 | ${stats.lounge_kr.positive} | ${lgRatio.positive}% | ${emoBar(stats.lounge_kr.positive, stats.lounge_kr.total)} |
| 😐 中性 | ${stats.lounge_kr.neutral} | ${lgRatio.neutral}% | ${emoBar(stats.lounge_kr.neutral, stats.lounge_kr.total)} |
| 😟 负面 | ${stats.lounge_kr.negative} | ${lgRatio.negative}% | ${emoBar(stats.lounge_kr.negative, stats.lounge_kr.total)} |

**正负对比**：正面 **${stats.lounge_kr.positive}** vs 负面 **${stats.lounge_kr.negative}** → **${getDominantSentiment(stats.lounge_kr)}**

### 🔥 热门话题

${formatTopicsTable(loungeTopics)}

${renderTopicDetails(loungeTopics)}

---

## ⚠️ 五、风险评估

**当前风险等级：${riskLevel}**

${generateRiskDetail(stats, { twitter: twitterTopics, discord_tc: tcTopics, lounge_kr: loungeTopics })}

${riskLevel.includes('高') ? '⚠️ 负面情绪占比过高，建议立即排查上述争议点，准备官方回应方案。' :
  riskLevel.includes('中') ? '⚡ 上述平台负面情绪偏高，建议密切关注话题走向，提前准备应急预案。' :
  '✅ 整体情绪稳定健康，保持当前运营节奏即可。'}

---

## 📝 六、运营建议

${generateSuggestions(stats, riskLevel, { twitter: twitterTopics, discord_tc: tcTopics, lounge_kr: loungeTopics })}

---

*本报告由 M2G 舆情监控系统自动生成 | 数据来源：Twitter + Discord（繁中服）+ Naver Lounge（韩服）*
`;

  return {
    markdown: report,
    summary,
    stats: {
      dateRange,
      totalRecords,
      platforms: {
        twitter: { ...stats.twitter, ratio: twRatio },
        discord_tc: { ...stats.discord_tc, ratio: tcRatio },
        lounge_kr: { ...stats.lounge_kr, ratio: lgRatio }
      },
      riskLevel,
      topics: { twitter: twitterTopics, discord_tc: tcTopics, lounge_kr: loungeTopics }
    }
  };
}

// ===== 主函数 =====

async function generateWeeklyReport() {
  console.log('\n📋 开始生成周报...');
  try {
    console.log('   📊 步骤1: 查询上周数据...');
    const weeklyData = await getWeeklyData();
    console.log(`   ✅ 查询完成，找到 ${weeklyData.totalRecords} 条记录`);

    if (weeklyData.totalRecords === 0) {
      console.warn('   ⚠️ 上周无数据');
      return { success: false, message: '上周无数据，无法生成报告。请先运行数据采集任务。' };
    }

    console.log('   📝 步骤2: 生成报告...');
    const report = await generateReport(weeklyData);
    console.log('   ✅ 报告生成完成');

    console.log('✅ 周报生成成功！');
    console.log(`   数据范围: ${weeklyData.dateRange.start} 至 ${weeklyData.dateRange.end}`);
    console.log(`   总记录数: ${weeklyData.totalRecords}`);

    return {
      success: true,
      report: report.markdown,
      summary: report.summary,
      stats: report.stats
    };
  } catch (error) {
    console.error('❌ 周报生成失败:', error);
    console.error('   错误详情:', error.stack);
    return { success: false, message: `生成失败: ${error.message}` };
  }
}

module.exports = {
  generateWeeklyReport,
  getLastWeekRange,
  getWeeklyData,
  generateReport // ★ 供验证脚本直调组装层（构造数据验证文案结构）
};

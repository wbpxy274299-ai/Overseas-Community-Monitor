/**
 * 周报生成模块
 * 从数据库查询上周数据，生成舆情监测报告
 * 数据来源：Twitter（Yahoo实时搜索）+ Discord（繁中服）
 * 不调用 AI，纯数据驱动
 */

const db = require('./db');
const aiAnalyzer = require('./ai_analyzer');

// ===== 日期工具 =====

// 本地时间字符串格式化（避免 toISOString 的 UTC 偏移问题）
function toLocalStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function getLastWeekRange() {
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
    start: toLocalStr(lastMonday),
    end: toLocalStr(lastSunday),
    startDate: lastMonday,
    endDate: lastSunday
  };
}

// ===== 数据获取 =====

async function getWeeklyData() {
  console.log('📊 查询上周舆情数据...');

  try {
    const sentiment = require('./sentiment');
    const allRecords = sentiment.getRecentFeedback(10000);
    console.log(`   📦 从数据库读取到 ${allRecords.length} 条记录`);

    if (allRecords.length === 0) {
      console.warn('   ⚠️ 无数据');
      return { dateRange: null, stats: null, totalRecords: 0 };
    }

    // 使用上周时间范围（周一~周日）
    const dateRange = getLastWeekRange();
    console.log(`   📅 上周范围: ${dateRange.start.substring(0,10)} 至 ${dateRange.end.substring(0,10)}`);

    // 只取上周范围内的记录
    const weeklyRecords = allRecords.filter(r => {
      const d = new Date(r.created_at);
      return d >= dateRange.startDate && d <= dateRange.endDate;
    });
    console.log(`   📋 上周记录: ${weeklyRecords.length} 条`);

    if (weeklyRecords.length === 0) {
      console.warn('   ⚠️ 上周无数据');
      return { dateRange, stats: null, totalRecords: 0 };
    }

    // 只统计 Twitter 和 Discord 繁中服
    const stats = {
      twitter: { total: 0, positive: 0, neutral: 0, negative: 0, records: [] },
      discord_tc: { total: 0, positive: 0, neutral: 0, negative: 0, records: [] }
    };

    for (const record of weeklyRecords) {
      const sent = record.sentiment || 'neutral';
      const bucket = sent === 'positive' ? 'positive' : sent === 'negative' ? 'negative' : 'neutral';

      if (record.platform === 'twitter') {
        stats.twitter.total++;
        stats.twitter[bucket]++;
        stats.twitter.records.push(record);
      } else if (record.platform === 'discord') {
        // 只收录繁中服（非日文内容）
        const isJapanese = /[\u3040-\u309f\u30a0-\u30ff]/.test(record.content);
        if (!isJapanese) {
          stats.discord_tc.total++;
          stats.discord_tc[bucket]++;
          stats.discord_tc.records.push(record);
        }
      }
    }

    const totalRecords = stats.twitter.total + stats.discord_tc.total;
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

function extractTopicsByTag(records, topN = 5) {
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
    
    // 收集样本发言(优先有翻译的)
    if (tagCounts[tag].samples.length < 3) {
      const text = record.translated_content || record.content || '';
      if (text && text.length > 10) {
        tagCounts[tag].samples.push({
          original: (record.content || '').substring(0, 200),
          translation: text.substring(0, 200),
          author: record.author || '匿名',
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
      
      return {
        tag,
        label: TAG_LABELS[tag] || tag,
        count: data.count,
        positives: data.positives,
        negatives: data.negatives,
        neutrals: data.neutrals,
        emotion_desc: emotionDesc,
        samples: data.samples.slice(0, 2) // 只保留前2条作为代表
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

// 生成可视化情绪比例条（Markdown 文本版）
function sentimentBar(pos, neu, neg) {
  const total = pos + neu + neg;
  if (total === 0) return '';
  const pW = Math.round((pos / total) * 20);
  const nW = Math.round((neg / total) * 20);
  const neuW = 20 - pW - nW;
  return `\`\`\`\n😊${'█'.repeat(pW)}${'▒'.repeat(Math.max(0, neuW))}${'▓'.repeat(nW)}😟\n\`\`\``;
}

function assessRiskLevel(stats) {
  const platforms = [stats.twitter, stats.discord_tc];
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
    '| 排名 | 话题 | 讨论人数 | 情绪分布 | 情绪风向 |',
    '|:---:|------|:---:|:---:|--------|'
  ];
  topics.forEach((t, i) => {
    const emoji = t.negatives > t.positives ? '⚠️' : t.positives > t.negatives ? '✅' : '➖';
    const sentDist = `👍${t.positives} 😐${t.neutrals} 👎${t.negatives}`;
    lines.push(`| ${i + 1} | **${t.label}** | ${t.count} 人 | ${sentDist} | ${t.emotion_desc} |`);
  });
  return lines.join('\n');
}

function formatTopicSamples(topic) {
  if (topic.samples.length === 0) return '> 暂无典型发言';
  
  let md = '';
  topic.samples.forEach((sample, idx) => {
    const sentEmoji = sample.sentiment === 'positive' ? '👍' : sample.sentiment === 'negative' ? '👎' : '💬';
    md += `**${sentEmoji} 玩家原声 #${idx + 1}**\n\n`;
    md += `> **原文**: ${sample.original}\n\n`;
    md += `> **翻译**: ${sample.translation}\n\n`;
    md += `> — ${sample.author} · [查看原帖](${sample.url}) · ${new Date(sample.created_at).toLocaleDateString('zh-CN')}\n\n`;
  });
  
  return md.trim();
}

function formatRecordsTable(records, count, platform) {
  if (records.length === 0) return '> 暂无典型发言';
  const platformLabel = platform === 'twitter' ? '🐦' : '💬';
  
  // 智能筛选：正面/负面/中性各取一些
  const positive = records.filter(r => r.sentiment === 'positive');
  const negative = records.filter(r => r.sentiment === 'negative');
  const neutral = records.filter(r => r.sentiment === 'neutral');
  
  const pickFrom = (arr, n) => {
    const withTrans = arr.filter(r => r.translated_content && r.translated_content.length > 10);
    const pool = withTrans.length >= n ? withTrans : arr;
    return pool.slice(0, n);
  };
  
  const posPicks = pickFrom(positive, 2);
  const negPicks = pickFrom(negative, 1);
  const neuPicks = pickFrom(neutral, 2);
  
  // 如果凑不够，补充剩余
  const allSelected = [...posPicks, ...negPicks, ...neuPicks];
  if (allSelected.length < count) {
    const usedIds = new Set(allSelected.map(r => r.id));
    const remaining = records.filter(r => !usedIds.has(r.id));
    allSelected.push(...pickFrom(remaining, count - allSelected.length));
  }
  
  const final = allSelected.slice(0, count);
  
  // 按情绪分组展示
  let md = '';
  const posGroup = final.filter(r => r.sentiment === 'positive');
  const negGroup = final.filter(r => r.sentiment === 'negative');
  const neuGroup = final.filter(r => r.sentiment === 'neutral' || !r.sentiment);
  
  if (posGroup.length > 0) {
    md += `**😊 正面评价**\n\n`;
    posGroup.forEach(r => {
      const text = (r.translated_content || r.content || '').substring(0, 150);
      md += `> 👍 ${text}\n> — ${r.author || '匿名'}（${platformLabel} · ${new Date(r.created_at).toLocaleDateString('zh-CN')}）\n\n`;
    });
  }
  if (negGroup.length > 0) {
    md += `**😟 负面反馈**\n\n`;
    negGroup.forEach(r => {
      const text = (r.translated_content || r.content || '').substring(0, 150);
      md += `> 👎 ${text}\n> — ${r.author || '匿名'}（${platformLabel} · ${new Date(r.created_at).toLocaleDateString('zh-CN')}）\n\n`;
    });
  }
  if (neuGroup.length > 0) {
    md += `**😐 中性讨论**\n\n`;
    neuGroup.forEach(r => {
      const text = (r.translated_content || r.content || '').substring(0, 150);
      md += `> 💬 ${text}\n> — ${r.author || '匿名'}（${platformLabel} · ${new Date(r.created_at).toLocaleDateString('zh-CN')}）\n\n`;
    });
  }
  
  return md.trim();
}

// ===== 运营建议 =====

function generateSuggestions(stats, riskLevel) {
  const s = [];
  if (stats.twitter.total > 0 && stats.twitter.negative > stats.twitter.positive) {
    s.push('- **Twitter 负面情绪偏高**：建议排查近期争议点，主动在官方账号回应');
  }
  if (stats.discord_tc.total > 0 && stats.discord_tc.negative > stats.discord_tc.positive) {
    s.push('- **繁中服 Discord 负面情绪较多**：建议在社区开展安抚活动或发布官方公告');
  }
  if (stats.twitter.total > stats.discord_tc.total * 2) {
    s.push('- **Twitter 讨论量远高于 Discord**：建议加大 Twitter 运营投入');
  } else if (stats.discord_tc.total > stats.twitter.total * 2) {
    s.push('- **Discord 讨论量远高于 Twitter**：建议加强 Discord 社区运营');
  }
  if (riskLevel === '🟢 低') {
    s.push('- **整体舆情健康**：可考虑推出新活动进一步提升玩家满意度');
  }
  s.push('- **持续监控**：建议每日查看舆情面板，及时发现并处理问题');
  return s.join('\n');
}

// ===== 总结 =====

function generateSummary(stats, totalRecords, riskLevel) {
  const totalNeg = stats.twitter.negative + stats.discord_tc.negative;
  const totalPos = stats.twitter.positive + stats.discord_tc.positive;
  const totalNeu = stats.twitter.neutral + stats.discord_tc.neutral;
  let mood = '😐 中性';
  if (totalNeg > totalPos * 1.5) mood = '😟 负面';
  else if (totalPos > totalNeg * 1.5) mood = '😊 正面';

  return `本周共收集 **${totalRecords}** 条玩家反馈，整体情绪 **${mood}**。

| 平台 | 总量 | 正面 | 中性 | 负面 |
|------|:---:|:---:|:---:|:---:|
| 🐦 Twitter | ${stats.twitter.total} | ${stats.twitter.positive} | ${stats.twitter.neutral} | ${stats.twitter.negative} |
| 💬 Discord | ${stats.discord_tc.total} | ${stats.discord_tc.positive} | ${stats.discord_tc.neutral} | ${stats.discord_tc.negative} |
| **合计** | **${totalRecords}** | **${totalPos}** | **${totalNeu}** | **${totalNeg}** |`;
}

// ===== 主报告生成 =====

async function generateReport(weeklyData) {
  const { dateRange, stats, totalRecords } = weeklyData;

  const twitterTopics = extractTopicsByTag(stats.twitter.records, 5);
  const tcTopics = extractTopicsByTag(stats.discord_tc.records, 5);

  const twRatio = calcRatio(stats.twitter.positive, stats.twitter.neutral, stats.twitter.negative);
  const tcRatio = calcRatio(stats.discord_tc.positive, stats.discord_tc.neutral, stats.discord_tc.negative);
  const riskLevel = assessRiskLevel(stats);
  const summary = generateSummary(stats, totalRecords, riskLevel);

  // AI 深度分析：调用 Gemini/Groq 生成智能总结
  let aiAnalysis = '';
  try {
    const aiStats = {
      twitter_count: stats.twitter.total,
      discord_count: stats.discord_tc.total,
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
      }))
    ];
    aiAnalysis = await aiAnalyzer.aiGenerateSummary(aiStats, sampleFeedbacks);
    console.log('   🤖 AI 分析生成成功');
  } catch (e) {
    console.warn('   ⚠️ AI 分析调用失败，使用默认文本:', e.message);
    aiAnalysis = '本周舆情整体平稳，建议持续关注玩家反馈。';
  }

  const report = `# 🎮 M2G 舆情监测周报

> 📅 报告周期：${dateRange.start.substring(0, 10)} ~ ${dateRange.end.substring(0, 10)}
> 🕐 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
> 📡 数据来源：Twitter（Yahoo实时搜索）+ Discord（繁中服）

---

## 📊 一、本周总览

${summary}

**风险等级**：${riskLevel}

---

## 🐦 二、Twitter 日服数据（${stats.twitter.total} 条）

| 情绪 | 数量 | 占比 | 可视化 |
|------|:---:|:---:|------|
| 😊 正面 | ${stats.twitter.positive} | ${twRatio.positive}% | ${'🟩'.repeat(Math.max(1, Math.round(stats.twitter.positive / Math.max(stats.twitter.total, 1) * 10)))} |
| 😐 中性 | ${stats.twitter.neutral} | ${twRatio.neutral}% | ${'🟨'.repeat(Math.max(1, Math.round(stats.twitter.neutral / Math.max(stats.twitter.total, 1) * 10)))} |
| 😟 负面 | ${stats.twitter.negative} | ${twRatio.negative}% | ${'🟥'.repeat(Math.max(1, Math.round(stats.twitter.negative / Math.max(stats.twitter.total, 1) * 10)))} |

**正负对比**：正面 **${stats.twitter.positive}** vs 负面 **${stats.twitter.negative}** → **${getDominantSentiment(stats.twitter)}**

### 🔥 热门话题

${formatTopicsTable(twitterTopics)}

${twitterTopics.map((topic, idx) => `
#### 话题 #${idx + 1}: ${topic.label}

**📊 讨论人数**: ${topic.count} 人

**📈 情绪分布**: 👍 正面 ${topic.positives} | 😐 中性 ${topic.neutrals} | 👎 负面 ${topic.negatives}

**🎯 情绪风向**: ${topic.emotion_desc}

**💬 玩家原声**:

${formatTopicSamples(topic)}
`).join('\n\n---\n\n')}

### 💬 典型发言

${formatRecordsTable(stats.twitter.records, 5, 'twitter')}

---

## 💬 三、Discord 繁中服数据（${stats.discord_tc.total} 条）

| 情绪 | 数量 | 占比 | 可视化 |
|------|:---:|:---:|------|
| 😊 正面 | ${stats.discord_tc.positive} | ${tcRatio.positive}% | ${'🟩'.repeat(Math.max(1, Math.round(stats.discord_tc.positive / Math.max(stats.discord_tc.total, 1) * 10)))} |
| 😐 中性 | ${stats.discord_tc.neutral} | ${tcRatio.neutral}% | ${'🟨'.repeat(Math.max(1, Math.round(stats.discord_tc.neutral / Math.max(stats.discord_tc.total, 1) * 10)))} |
| 😟 负面 | ${stats.discord_tc.negative} | ${tcRatio.negative}% | ${'🟥'.repeat(Math.max(1, Math.round(stats.discord_tc.negative / Math.max(stats.discord_tc.total, 1) * 10)))} |

**正负对比**：正面 **${stats.discord_tc.positive}** vs 负面 **${stats.discord_tc.negative}** → **${getDominantSentiment(stats.discord_tc)}**

### 🔥 热门话题

${formatTopicsTable(tcTopics)}

${tcTopics.map((topic, idx) => `
#### 话题 #${idx + 1}: ${topic.label}

**📊 讨论人数**: ${topic.count} 人

**📈 情绪分布**: 👍 正面 ${topic.positives} | 😐 中性 ${topic.neutrals} | 👎 负面 ${topic.negatives}

**🎯 情绪风向**: ${topic.emotion_desc}

**💬 玩家原声**:

${formatTopicSamples(topic)}
`).join('\n\n---\n\n')}

### 💬 典型发言

${formatRecordsTable(stats.discord_tc.records, 5, 'discord')}

---

## ⚠️ 四、风险评估

**当前风险等级：${riskLevel}**

${riskLevel.includes('高') ? '⚠️ 负面情绪占比过高，建议立即排查近期争议点，准备官方回应方案。重点关注 Twitter 和 Discord 上的负面集中话题。' :
  riskLevel.includes('中') ? '⚡ 部分平台负面情绪偏高，建议密切关注相关话题走向，提前准备应急预案。' :
  '✅ 整体情绪稳定健康，未发现明显风险信号。建议保持当前运营节奏。'}

---

## 📝 五、运营建议

${generateSuggestions(stats, riskLevel)}

---

## 🤖 六、AI 智能分析

${aiAnalysis}

---

*本报告由 M2G 舆情监控系统自动生成 | 数据来源：Twitter + Discord（繁中服）*
`;

  return {
    markdown: report,
    summary,
    stats: {
      dateRange,
      totalRecords,
      platforms: {
        twitter: { ...stats.twitter, ratio: twRatio },
        discord_tc: { ...stats.discord_tc, ratio: tcRatio }
      },
      riskLevel,
      topics: { twitter: twitterTopics, discord_tc: tcTopics }
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
  getWeeklyData
};

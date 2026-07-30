/**
 * 舆情监控面板 — 页面逻辑
 */
const API_BASE = '/api/sentiment';

// 热度说明开关
function toggleHeatHelp() {
  const el = document.getElementById('heatHelpBrief');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// 加载统计数据
async function loadStatistics() {
  showLoading();
  try {
    const response = await fetch(`${API_BASE}/statistics?period=today`);
    const data = await response.json();
    
    if (data.ok) {
      const riskLevel = data.data.risk_level || 'low';
      // 更新今日快报摘要
      updateDailyBrief(data.data, riskLevel);
      const cacheStatus = data.cached ? '（缓存）' : '（最新）';
      console.log(`📊 统计数据已更新 ${cacheStatus}`);
    }
  } catch (error) {
    console.error('加载统计数据失败:', error);
  } finally {
    hideLoading();
  }
}

function showLoading() {
  document.getElementById('loadingOverlay').classList.add('active');
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('active');
}

// 渲染 Twitter 情感图表
function renderTwitterSentimentChart(bySentiment) {
  const container = document.getElementById('twitterSentimentChart');
  const positive = bySentiment?.positive || 0;
  const neutral = bySentiment?.neutral || 0;
  const negative = bySentiment?.negative || 0;
  const total = positive + neutral + negative;
  if (total === 0) { container.innerHTML = '<div style="color: var(--color-text-muted, #999);">暂无数据</div>'; return; }
  const posPercent = Math.round((positive / total) * 100);
  const neuPercent = Math.round((neutral / total) * 100);
  const negPercent = Math.round((negative / total) * 100);
  container.innerHTML = `
    <div style="width: 100%; padding: 20px;">
      <div style="display: flex; justify-content: space-around; margin-bottom: 20px;">
        <div style="text-align: center;">
          <div style="font-size: 24px; color: #10b981; font-weight: bold;">${posPercent}%</div>
          <div style="font-size: 12px; color: var(--color-text-secondary, #666);">正面 ${positive}</div>
        </div>
        <div style="text-align: center;">
          <div style="font-size: 24px; color: #6b7280; font-weight: bold;">${neuPercent}%</div>
          <div style="font-size: 12px; color: var(--color-text-secondary, #666);">中性 ${neutral}</div>
        </div>
        <div style="text-align: center;">
          <div style="font-size: 24px; color: #ef4444; font-weight: bold;">${negPercent}%</div>
          <div style="font-size: 12px; color: var(--color-text-secondary, #666);">负面 ${negative}</div>
        </div>
      </div>
      <div style="height: 20px; background: var(--color-border-light, #f3f4f6); border-radius: 10px; overflow: hidden; display: flex;">
        <div style="width: ${posPercent}%; background: #10b981;"></div>
        <div style="width: ${neuPercent}%; background: #6b7280;"></div>
        <div style="width: ${negPercent}%; background: #ef4444;"></div>
      </div>
    </div>`;
}

// 渲染 Discord 情感图表
function renderDiscordSentimentChart(bySentiment) {
  const container = document.getElementById('discordSentimentChart');
  const positive = bySentiment?.positive || 0;
  const neutral = bySentiment?.neutral || 0;
  const negative = bySentiment?.negative || 0;
  const total = positive + neutral + negative;
  if (total === 0) { container.innerHTML = '<div style="color: var(--color-text-muted, #999);">暂无数据</div>'; return; }
  const posPercent = Math.round((positive / total) * 100);
  const neuPercent = Math.round((neutral / total) * 100);
  const negPercent = Math.round((negative / total) * 100);
  container.innerHTML = `
    <div style="width: 100%; padding: 20px;">
      <div style="display: flex; justify-content: space-around; margin-bottom: 20px;">
        <div style="text-align: center;">
          <div style="font-size: 24px; color: #10b981; font-weight: bold;">${posPercent}%</div>
          <div style="font-size: 12px; color: var(--color-text-secondary, #666);">正面 ${positive}</div>
        </div>
        <div style="text-align: center;">
          <div style="font-size: 24px; color: #6b7280; font-weight: bold;">${neuPercent}%</div>
          <div style="font-size: 12px; color: var(--color-text-secondary, #666);">中性 ${neutral}</div>
        </div>
        <div style="text-align: center;">
          <div style="font-size: 24px; color: #ef4444; font-weight: bold;">${negPercent}%</div>
          <div style="font-size: 12px; color: var(--color-text-secondary, #666);">负面 ${negative}</div>
        </div>
      </div>
      <div style="height: 20px; background: var(--color-border-light, #f3f4f6); border-radius: 10px; overflow: hidden; display: flex;">
        <div style="width: ${posPercent}%; background: #10b981;"></div>
        <div style="width: ${neuPercent}%; background: #6b7280;"></div>
        <div style="width: ${negPercent}%; background: #ef4444;"></div>
      </div>
    </div>`;
}

// 渲染区域分布
function renderRegionDistribution(regions) {
  const container = document.getElementById('regionDistribution');
  if (!regions || regions.length === 0) {
    container.innerHTML = '<span style="color: var(--color-text-muted, #999);">暂无数据</span>';
    return;
  }
  let html = '';
  regions.forEach(r => {
    const percent = ((r.count / regions.reduce((sum, x) => sum + x.count, 0)) * 100).toFixed(1);
    html += `<div>${r.label}: ${r.count}条 (${percent}%)</div>`;
  });
  container.innerHTML = html;
}

// ===== 今日快报摘要更新 =====
function updateDailyBrief(data, riskLevel) {
  const twEl = document.getElementById('briefTwCount');
  const dcEl = document.getElementById('briefDcCount');
  const loungeEl = document.getElementById('briefLoungeCount');
  const riskEl = document.getElementById('briefRisk');
  const moodEl = document.getElementById('briefMood');
  if (twEl) twEl.textContent = data.twitter_count || 0;
  if (dcEl) dcEl.textContent = data.discord_count || 0;
  if (loungeEl) loungeEl.textContent = data.lounge_count || 0;
  const riskLabels = { low: '🟢 低', medium: '🟡 中', high: '🔴 高' };
  if (riskEl) riskEl.textContent = riskLabels[riskLevel] || '-';
  // 情绪从 twitter + discord + lounge 情感分布计算
  const twS = data.twitter_sentiment || {};
  const dcS = data.discord_sentiment || {};
  const loungeS = data.lounge_sentiment || {};
  const pos = (twS.positive || 0) + (dcS.positive || 0) + (loungeS.positive || 0);
  const neg = (twS.negative || 0) + (dcS.negative || 0) + (loungeS.negative || 0);
  const neu = (twS.neutral || 0) + (dcS.neutral || 0) + (loungeS.neutral || 0);
  const total = pos + neg + neu;
  if (total > 0 && moodEl) {
    const posR = Math.round(pos / total * 100);
    const negR = Math.round(neg / total * 100);
    if (posR >= 60) moodEl.textContent = `😊 ${posR}%正面`;
    else if (negR >= 40) moodEl.textContent = `😟 ${negR}%负面`;
    else moodEl.textContent = `😐 平稳`;
  } else if (moodEl) {
    moodEl.textContent = '-';
  }
}

// ===== 七日舆情趋势 =====
async function loadWeeklyOverview() {
  try {
    const res = await fetch(`${API_BASE}/weekly-overview`);
    const result = await res.json();
    if (result.ok && result.data) {
      renderWeeklyStats(result.data);
      renderWeeklyBarChart(result.data.days);
      renderWeeklySentimentTrack(result.data.days);
    }
  } catch (e) {
    console.error('加载七日概览失败:', e);
  }
}

function renderWeeklyStats(overview) {
  const totalEl = document.getElementById('weeklyTotal');
  const avgEl = document.getElementById('weeklyDailyAvg');
  const trendEl = document.getElementById('weeklyTrendChange');
  const totalSubEl = document.getElementById('weeklyTotalSub');
  const avgSubEl = document.getElementById('weeklyDailyAvgSub');
  const trendSubEl = document.getElementById('weeklyTrendSub');
  
  if (totalEl) totalEl.textContent = overview.total;
  if (totalSubEl) totalSubEl.textContent = `TW:${overview.totalTwitter} DC:${overview.totalDiscord} KR:${overview.totalLounge || 0}`;
  if (avgEl) avgEl.textContent = overview.dailyAvg;
  
  const tc = overview.trendChange;
  if (trendEl) {
    if (tc > 0) { trendEl.textContent = `📈 +${tc}`; trendEl.style.color = '#ef4444'; }
    else if (tc < 0) { trendEl.textContent = `📉 ${tc}`; trendEl.style.color = '#10b981'; }
    else { trendEl.textContent = '➡️ 持平'; trendEl.style.color = ''; }
  }
  if (trendSubEl) trendSubEl.textContent = '较前一日';
  
  const hotEl = document.getElementById('weeklyHotTopic');
  const hotSubEl = document.getElementById('weeklyHotSub');
  if (hotEl) hotEl.textContent = overview.hotTopic || '-';
  if (hotSubEl) hotSubEl.textContent = overview.hotTopicCount > 0 ? `${overview.hotTopicCount} 条讨论` : '本周无话题';
}

function renderWeeklyBarChart(days) {
  const container = document.getElementById('weeklyBarChart');
  if (!container || !days) return;
  const maxTotal = Math.max(...days.map(d => d.total), 1);
  const maxBarH = 140;
  
  let html = '';
  for (const d of days) {
    const twH = Math.max(Math.round((d.twitter / maxTotal) * maxBarH), d.twitter > 0 ? 4 : 0);
    const dcH = Math.max(Math.round((d.discord / maxTotal) * maxBarH), d.discord > 0 ? 4 : 0);
    const krH = Math.max(Math.round(((d.lounge||0) / maxTotal) * maxBarH), (d.lounge||0) > 0 ? 4 : 0);
    const isToday = d === days[days.length - 1];
    html += `<div class="wbc-day">
      <div class="wbc-bars">
        <div class="wbc-bar tw" style="height:${twH}px;" title="Twitter: ${d.twitter}">
          ${d.twitter > 0 ? `<span class="wbc-bar-label">${d.twitter}</span>` : ''}
        </div>
        <div class="wbc-bar dc" style="height:${dcH}px;" title="Discord: ${d.discord}">
          ${d.discord > 0 ? `<span class="wbc-bar-label">${d.discord}</span>` : ''}
        </div>
        <div class="wbc-bar kr" style="height:${krH}px;background:#f59e0b;" title="🇰🇷 Naver: ${d.lounge||0}">
          ${(d.lounge||0) > 0 ? `<span class="wbc-bar-label">${d.lounge}</span>` : ''}
        </div>
      </div>
      <div class="wbc-date" style="${isToday ? 'color:var(--color-primary,#667eea);font-weight:800;' : ''}">${d.label}${isToday ? '(今)' : ''}</div>
      <div class="wbc-total">${d.total}</div>
    </div>`;
  }
  container.innerHTML = html;
}

function renderWeeklySentimentTrack(days) {
  const container = document.getElementById('weeklySentimentTrack');
  if (!container || !days) return;
  
  let html = '';
  for (const d of days) {
    const s = d.sentiment || { positive: 0, neutral: 0, negative: 0 };
    const total = (s.positive || 0) + (s.neutral || 0) + (s.negative || 0);
    const isToday = d === days[days.length - 1];
    if (total > 0) {
      const posW = Math.round((s.positive / total) * 100);
      const neuW = Math.round((s.neutral / total) * 100);
      const negW = 100 - posW - neuW;
      html += `<div class="wst-day">
        <div class="wst-bar">
          <div class="wst-seg-pos" style="width:${posW}%"></div>
          <div class="wst-seg-neu" style="width:${neuW}%"></div>
          <div class="wst-seg-neg" style="width:${negW}%"></div>
        </div>
        <div class="wst-date" style="${isToday ? 'color:var(--color-primary,#667eea);font-weight:800;' : ''}">${d.label}${isToday ? '(今)' : ''}</div>
        <div class="wst-ratio">😊${posW}% 😟${negW}%</div>
      </div>`;
    } else {
      html += `<div class="wst-day">
        <div class="wst-bar" style="background:#e5e7eb;"></div>
        <div class="wst-date">${d.label}${isToday ? '(今)' : ''}</div>
        <div class="wst-ratio">无数据</div>
      </div>`;
    }
  }
  container.innerHTML = html;
}

// ===== 七日热门话题 =====
async function loadWeeklyHotTopics() {
  try {
    const res = await fetch(`${API_BASE}/weekly-hot-topics`);
    const result = await res.json();
    if (result.ok && result.data) {
      renderWeeklyTopicColumn('weeklyTwitterTopics', result.data.twitter_topics || []);
      renderWeeklyTopicColumn('weeklyDiscordTopics', result.data.discord_topics || []);
    }
  } catch (e) {
    console.error('加载七日热门话题失败:', e);
  }
}

function renderWeeklyTopicColumn(containerId, topics) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!topics || topics.length === 0) {
    container.innerHTML = '<div class="wtp-empty">7日内暂无话题数据</div>';
    return;
  }
  const sentimentIcon = s => s === 'positive' ? '😊' : s === 'negative' ? '😟' : '😐';
  const sentimentColor = s => s === 'positive' ? '#10b981' : s === 'negative' ? '#ef4444' : '#6b7280';
  const sentimentLabel = s => s === 'positive' ? '正面' : s === 'negative' ? '负面' : '中性';
  const tagColors = {
    bug_report: '#ef4444', gacha: '#f59e0b', knight_order: '#8b5cf6',
    tree_bond: '#10b981', event: '#3b82f6', cosmetic: '#ec4899',
    world_boss: '#f97316', photo: '#06b6d4', pricing: '#eab308',
    server: '#6366f1', general: '#6b7280', login: '#14b8a6',
    gameplay: '#f472b6', story: '#a78bfa', collab: '#fb923c',
  };
  let html = '';
  for (const t of topics) {
    const sColor = sentimentColor(t.sentiment);
    const sIcon = sentimentIcon(t.sentiment);
    const tagColor = tagColors[t.tag] || '#6b7280';
    // 原声样本（已清洗）
    let voicesHtml = '';
    if (t.voices && t.voices.length > 0) {
      voicesHtml = '<div class="wtp-voices">';
      for (const v of t.voices) {
        const linkHtml = v.url ? `<a href="${v.url}" target="_blank" rel="noopener" class="wtp-link">原帖↗</a>` : '';
        const vSIcon = sentimentIcon(v.sentiment);
        voicesHtml += `<div class="wtp-voice">
          <div class="wtp-voice-text">${vSIcon} ${escapeHtml(v.text)}</div>
          <div class="wtp-voice-meta">
            <span class="wtp-voice-author">👤 ${escapeHtml(v.author)}</span>
            ${linkHtml}
          </div>
        </div>`;
      }
      voicesHtml += '</div>';
    }
    // 情绪分布条
    const total = (t.neg || 0) + (t.pos || 0) + (t.neu || 0);
    let moodBar = '';
    if (total > 0) {
      const posW = Math.round((t.pos || 0) / total * 100);
      const negW = Math.round((t.neg || 0) / total * 100);
      const neuW = 100 - posW - negW;
      moodBar = `<div class="wtp-mood-bar">
        <div class="wtp-mood-pos" style="width:${posW}%" title="正面 ${posW}%"></div>
        <div class="wtp-mood-neg" style="width:${negW}%" title="负面 ${negW}%"></div>
        <div class="wtp-mood-neu" style="width:${neuW}%" title="中性 ${neuW}%"></div>
      </div>`;
    }
    html += `<div class="wtp-card">
      <div class="wtp-card-header">
        <span class="wtp-card-title">${sIcon} ${t.title}</span>
        <span class="wtp-card-heat">🔥 ${t.heat}/10</span>
      </div>
      <div class="wtp-card-stats">
        <span>${t.count}条讨论</span>
        <span style="color:#10b981;">👍${t.pos || 0}</span>
        <span style="color:#ef4444;">👎${t.neg || 0}</span>
      </div>
      ${moodBar}
      <div class="wtp-card-overview">${escapeHtml(t.overview)}</div>
      ${voicesHtml}
    </div>`;
  }
  container.innerHTML = html;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 加载情绪倾向分析
async function loadSentimentTrend() {
  try {
    const response = await fetch(`${API_BASE}/sentiment-trend?days=7`);
    const data = await response.json();
    if (data.ok && data.data) { renderSentimentTrend(data.data); }
  } catch (error) {
    console.error('加载情绪倾向失败:', error);
    document.getElementById('sentimentTrend').innerHTML = '<span style="color: var(--color-text-muted, #999);">加载失败</span>';
  }
}

// 渲染情绪倾向
function renderSentimentTrend(analysis) {
  const container = document.getElementById('sentimentTrend');
  const trendIcon = analysis.overall_trend === 'positive' ? '😊 正面' :
                   analysis.overall_trend === 'negative' ? '😟 负面' : '😐 稳定';
  let html = `<div style="margin-bottom: 8px;">${trendIcon}</div>`;
  html += `<div style="font-size: 12px; color: var(--color-text-secondary, #666);">`;
  html += `😊 ${analysis.sentiment_ratio.positive} |  ${analysis.sentiment_ratio.negative}`;
  html += `</div>`;
  if (analysis.pain_points && analysis.pain_points.length > 0) {
    html += `<div style="font-size: 11px; color: var(--color-text-muted, #999); margin-top: 4px;">主要痛点: `;
    html += analysis.pain_points.slice(0, 2).map(p => p.label).join(', ');
    html += `</div>`;
  }
  container.innerHTML = html;
}

// 全局变量：存储话题趋势数据
let topicTrends = {};

// 加载 AI 热门话题总结
async function loadAITopics() {
  try {
    console.log('🤖 加载AI热门话题...');
    document.getElementById('twitterTopics').innerHTML = '<div class="loading">AI 分析中...</div>';
    document.getElementById('discordTopics').innerHTML = '<div class="loading">AI 分析中...</div>';
    const response = await fetch(`${API_BASE}/hot-topics`);
    const result = await response.json();
    if (result.ok) {
      if (result.analyzing) {
        renderAnalyzing();
      } else if (result.diagnosis) {
        renderDiagnosis(result.diagnosis);
      } else {
        renderAITopics(result.data);
      }
    } else {
      renderTopicError(result.error || '未知错误');
    }
  } catch (error) {
    console.error('加载AI话题失败:', error);
    renderTopicError(error.message);
  }
}

// 显示“正在分析中”
function renderAnalyzing() {
  const html = `
    <div style="padding: 30px; text-align: center; color: var(--color-text-secondary, #666);">
      <div style="font-size: 32px; margin-bottom: 12px;">⏳</div>
      <div style="font-size: 15px; font-weight: bold; margin-bottom: 6px; color: var(--color-text, #333);">AI 正在分析中...</div>
      <div style="font-size: 13px;">请稍后刷新页面查看结果</div>
    </div>`;
  document.getElementById('twitterTopics').innerHTML = html;
  document.getElementById('discordTopics').innerHTML = html;
}

// 显示诊断信息：告诉用户为什么没数据 + 指引看存档
function renderDiagnosis(d) {
  const reasonIcon = d.reason === 'collection_failed' ? '❌' : d.reason === 'ai_failed' ? '🤖' : '📭';
  const reasonTitle = d.reason === 'collection_failed' ? '采集失败' :
                      d.reason === 'ai_failed' ? 'AI 分析失败' :
                      d.reason === 'no_posts' ? '玩家暂无发言' : '暂无数据';
  // 详细原因分行显示
  const detailLines = (d.detail || '').split('\n').map(l => `<div style="margin: 4px 0;">${l}</div>`).join('');
  const html = `
    <div style="padding: 24px; text-align: center;">
      <div style="font-size: 36px; margin-bottom: 10px;">${reasonIcon}</div>
      <div style="font-size: 16px; font-weight: bold; color: var(--color-text, #333); margin-bottom: 12px;">${reasonTitle}</div>
      <div style="font-size: 13px; color: var(--color-text-secondary, #666); line-height: 1.8; text-align: left; max-width: 360px; margin: 0 auto;">
        ${detailLines}
      </div>
      ${d.twitterError || d.discordError ? `<div style="margin-top: 12px; font-size: 12px; color: #ef4444;">请检查网络/代理是否正常，或等待系统自动重试</div>` : ''}
      <div style="margin-top: 16px;">
        <button onclick="scrollToSnapshots()" style="padding: 8px 20px; background: #6366f1; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">📂 查看昨日舆情存档</button>
      </div>
    </div>`;
  document.getElementById('twitterTopics').innerHTML = html;
  document.getElementById('discordTopics').innerHTML = `
    <div style="padding: 24px; text-align: center; color: var(--color-text-muted, #999);">
      <div style="font-size: 13px;">与 Twitter 相同的原因</div>
    </div>`;
}

// 滚动到存档区域
function scrollToSnapshots() {
  const el = document.getElementById('snapshotSection') || document.querySelector('[id*=snapshot]') || document.querySelector('[id*=Snapshot]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth' });
  } else {
    // 如果没有存档区域，切换到历史页面
    window.location.href = '/sentiment-history';
  }
}

// 渲染话题加载失败
function renderTopicError(msg) {
  const errorHTML = `
    <div style="padding: 20px; text-align: center; color: var(--text-secondary);">
      <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
      <div>话题加载失败: ${msg}</div>
    </div>`;
  document.getElementById('twitterTopics').innerHTML = errorHTML;
  document.getElementById('discordTopics').innerHTML = errorHTML;
}

// 渲染 AI 生成的热门话题
function renderAITopics(data) {
  console.log('🎨 开始渲染AI话题，数据:', data);
  const twitterContainer = document.getElementById('twitterTopics');
  const discordContainer = document.getElementById('discordTopics');
  let twitterTopics = [];
  let discordTopics = [];
  if (Array.isArray(data)) {
    twitterTopics = data;
    discordTopics = [];
  } else if (data && typeof data === 'object') {
    twitterTopics = data.twitter_topics || [];
    discordTopics = data.discord_topics || [];
  }
  const sortBySentiment = (arr) => {
    const order = { negative: 0, neutral: 1, positive: 2 };
    return [...arr].sort((a, b) => (order[a.sentiment] ?? 1) - (order[b.sentiment] ?? 1));
  };
  const tagColors = {
    bug_report: '#ef4444', gacha: '#f59e0b', knight_order: '#8b5cf6',
    tree_bond: '#10b981', event: '#3b82f6', cosmetic: '#ec4899',
    world_boss: '#f97316', photo: '#06b6d4', pricing: '#eab308',
    server: '#6366f1', general: '#6b7280'
  };
  const tagLabels = {
    bug_report: 'Bug', gacha: '抽卡', knight_order: '骑士团',
    tree_bond: '树缘', event: '活动', cosmetic: '时装',
    world_boss: '世界Boss', photo: '拍照', pricing: '充值',
    server: '服务器', general: '其他'
  };

  function renderTopicCard(topic) {
    const sentimentColor = topic.sentiment === 'positive' ? '#10b981' :
                          topic.sentiment === 'negative' ? '#ef4444' : '#6b7280';
    const sentimentIcon = topic.sentiment === 'positive' ? '😊' :
                         topic.sentiment === 'negative' ? '😟' : '😐';
    const tagColor = tagColors[topic.tag] || '#6b7280';
    const tagLabel = tagLabels[topic.tag] || topic.tag || '';
    const trendKey = `${topic.title}_${topic.tag || 'general'}`;
    const trendData = topicTrends[trendKey];
    let trendIndicator = '';
    if (trendData) {
      if (trendData.trend === 'rising') {
        trendIndicator = '<span style="color: #ef4444; font-size: 14px;" title="热度上升">📈</span>';
      } else if (trendData.trend === 'falling') {
        trendIndicator = '<span style="color: #10b981; font-size: 14px;" title="热度下降"></span>';
      }
    }
    const sentimentText = topic.sentiment === 'positive' ? '正面' :
                         topic.sentiment === 'negative' ? '负面' : '中性';
    let channelDisplay = topic.channel_name || '';
    let isMultiChannel = false;
    if (channelDisplay && channelDisplay.includes(',')) {
      isMultiChannel = true;
      const channels = channelDisplay.split(',').map(c => c.trim());
      channelDisplay = `<span style="color: #8b5cf6; font-weight: bold;">${channels.length}个频道</span>: ${channels.join(', ')}`;
    }
    let card = `<div style="padding: 16px; background: var(--color-card-bg, white); border-radius: 8px;
                border-left: 4px solid ${sentimentColor}; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 18px;">${sentimentIcon}</span>
          <span style="font-weight: bold; font-size: 15px; color: var(--color-text, #333);">${topic.title}</span>
          ${tagLabel ? `<span style="font-size: 11px; padding: 2px 8px; background: ${tagColor}; color: white; border-radius: 10px;">${tagLabel}</span>` : ''}
          ${trendIndicator}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 11px; color: var(--color-text-muted, #999);">讨论数: ${topic.count || 0}条</span>
          <span style="font-size: 12px; color: var(--color-text-muted, #999);">热度 ${topic.heat}/10</span>
        </div>
      </div>
      ${isMultiChannel ? `
      <div style="margin-bottom: 8px; padding: 4px 8px; background: var(--color-surface-raised, #f5f3ff); border-radius: 4px; border-left: 3px solid #8b5cf6;">
        <span style="font-size: 12px; color: var(--color-text-secondary, #666);">📍 出现在: ${channelDisplay}</span>
      </div>` : ''}
      <div style="margin-bottom: 8px;">
        <span style="font-size: 12px; color: ${sentimentColor}; font-weight: bold;">📊 情绪倾向: ${sentimentText}</span>
      </div>
      <div style="font-size: 13px; color: var(--color-text-secondary, #666); line-height: 1.6; margin-bottom: 8px; padding: 8px; background: var(--color-border-light, #f9fafb); border-radius: 4px;">
        ${topic.summary}
      </div>
      ${topic.detail ? `
      <div style="margin-bottom: 8px; padding: 10px 12px; background: var(--color-surface-raised, #f0f9ff); border-radius: 6px; border-left: 3px solid #0ea5e9;">
        <div style="font-size: 11px; color: #0369a1; font-weight: bold; margin-bottom: 4px;">🔍 深度分析</div>
        <div style="font-size: 13px; color: var(--color-text, #334155); line-height: 1.7;">${topic.detail}</div>
      </div>` : ''}`;
    if (topic.representative_quotes && topic.representative_quotes.length > 0) {
      card += `<div style="margin-bottom: 8px;">
        <div style="font-size: 12px; color: var(--color-text-muted, #999); margin-bottom: 4px;">💬 玩家原声:</div>`;
      topic.representative_quotes.forEach((quote) => {
        // 兼容旧格式（字符串）和新格式（对象）
        const text = typeof quote === 'object' ? quote.text : quote;
        const time = typeof quote === 'object' ? quote.created_at : '';
        card += `<div style="font-size: 12px; color: var(--color-text-secondary, #555); padding: 4px 8px; background: var(--color-surface-raised, #fef3c7); border-left: 3px solid #f59e0b; margin-bottom: 4px; border-radius: 2px;">
          <span style="color: var(--color-text-secondary, #666);">\u201c${text}\u201d</span>
          ${time ? `<span style="float: right; color: var(--color-text-muted, #999); font-size: 11px;">${time}</span>` : ''}
        </div>`;
      });
      card += '</div>';
    }
    if (topic.urls && topic.urls.length > 0) {
      card += `<div style="margin-bottom: 8px;">
        <div style="font-size: 12px; color: var(--color-text-muted, #999); margin-bottom: 4px;">🔗 代表性发言:</div>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">`;
      topic.urls.forEach((url, idx) => {
        if (idx < 3) {
          card += `<a href="${url}" target="_blank" style="font-size: 11px; color: #3b82f6; text-decoration: none; padding: 2px 6px; background: #eff6ff; border-radius: 4px;">查看原文 ↗</a>`;
        }
      });
      card += '</div></div>';
    }
    if (topic.action) {
      card += `<div style="font-size: 12px; color: #8b5cf6; padding: 6px 10px; background: #f5f3ff; border-radius: 4px; border-left: 3px solid #8b5cf6;">建议: ${topic.action}</div>`;
    }
    card += '</div>';
    return card;
  }

  twitterTopics = sortBySentiment(twitterTopics);
  if (twitterTopics.length === 0) {
    twitterContainer.innerHTML = '<div style="padding: 20px; color: var(--color-text-muted, #999);">暂无数据</div>';
  } else {
    let html = '<div style="display: flex; flex-direction: column; gap: 12px; padding: 20px;">';
    for (const topic of twitterTopics.slice(0, 8)) { html += renderTopicCard(topic); }
    html += '</div>';
    twitterContainer.innerHTML = html;
  }
  discordTopics = sortBySentiment(discordTopics);
  if (discordTopics.length === 0) {
    discordContainer.innerHTML = '<div style="padding: 20px; color: var(--color-text-muted, #999);">暂无数据</div>';
  } else {
    let html = '<div style="display: flex; flex-direction: column; gap: 12px; padding: 20px;">';
    for (const topic of discordTopics.slice(0, 8)) { html += renderTopicCard(topic); }
    html += '</div>';
    discordContainer.innerHTML = html;
  }
}

// 渲染 Twitter 热门话题（降级方案）
function renderTwitterTopics(topics) {
  const container = document.getElementById('twitterTopics');
  if (!topics || topics.length === 0) { container.innerHTML = '<div style="padding: 20px; color: #999;">暂无数据</div>'; return; }
  let html = '<div style="display: flex; flex-wrap: wrap; gap: 10px; padding: 20px;">';
  for (const topic of topics.slice(0, 8)) {
    html += `<div style="padding: 8px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border-radius: 20px; font-size: 13px;">${topic.name} (${topic.count})</div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// 渲染 Discord 热门话题
function renderDiscordTopics(topics) {
  const container = document.getElementById('discordTopics');
  if (!topics || topics.length === 0) { container.innerHTML = '<div style="padding: 20px; color: #999;">暂无数据</div>'; return; }
  let html = '<div style="display: flex; flex-wrap: wrap; gap: 10px; padding: 20px;">';
  for (const topic of topics.slice(0, 8)) {
    html += `<div style="padding: 8px 16px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; border-radius: 20px; font-size: 13px;">${topic.name} (${topic.count})</div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// 加载快报监控时间
async function loadDailyFeedback() {
  try {
    const response = await fetch(`${API_BASE}/statistics?period=today`);
    const data = await response.json();
    if (data.ok && data.data.period) {
      const el = document.getElementById('briefMonitorTime');
      if (el) el.textContent = `📅 监控时间：${data.data.period}`;
    }
  } catch (error) {
    console.error('获取监控时间失败:', error);
    const el = document.getElementById('briefMonitorTime');
    if (el) el.textContent = '📅 监控时间：前一日 8:30 ~ 今日 8:30';
  }
}

// ===== 发言概况（始终显示概述） =====
async function loadHotTopicsBrief() {
  try {
    document.getElementById('briefTwitterTopics').innerHTML = '<div class="loading">加载中...</div>';
    document.getElementById('briefDiscordTopics').innerHTML = '<div class="loading">加载中...</div>';
    // 只加载每日概述（发言画像）
    await loadDailyBriefOverview();
  } catch (e) {
    console.error('加载发言概况失败:', e);
    renderBriefDiagnosis({ reason: 'no_data' });
  }
}

// 加载每日舆情概述（无话题时的兑底显示）
async function loadDailyBriefOverview() {
  try {
    const res = await fetch(`${API_BASE}/daily-overview`);
    const result = await res.json();
    if (result.ok && result.data) {
      renderDailyBriefOverview(result.data);
    } else {
      renderBriefDiagnosis({ reason: 'no_data' });
    }
  } catch (e) {
    console.error('加载每日概述失败:', e);
    renderBriefDiagnosis({ reason: 'no_data' });
  }
}

function renderDailyBriefOverview(data) {
  const twContainer = document.getElementById('briefTwitterTopics');
  const dcContainer = document.getElementById('briefDiscordTopics');
  
  function renderPlatform(el, platformData) {
    if (!platformData || !platformData.hasData) {
      el.innerHTML = '<div class="brief-topic-notice">📭 今日暂无玩家发言</div>';
      return;
    }
    // 只显示概述文本，不显示原声
    el.innerHTML = `<div class="brief-overview-text">${platformData.text}</div>`;
  }
  
  if (twContainer) renderPlatform(twContainer, data.twitter);
  if (dcContainer) renderPlatform(dcContainer, data.discord);
}

// 在概述下方追加热门话题卡片
function appendBriefHotTopics(container, topics) {
  if (!container || !topics || topics.length === 0) return;
  const sentimentIcon = s => s === 'positive' ? '😊' : s === 'negative' ? '😟' : '😐';
  const sentimentColor = s => s === 'positive' ? '#10b981' : s === 'negative' ? '#ef4444' : '#9ca3af';
  
  let html = '<div class="brief-hottopics-append"><div class="bha-title">🔥 热门话题</div>';
  for (const t of topics.slice(0, 3)) {
    const sColor = sentimentColor(t.sentiment);
    const sIcon = sentimentIcon(t.sentiment);
    html += `<div class="brief-topic-card" style="border-left:3px solid ${sColor};">
      <div class="btc-title">${sIcon} ${t.title}</div>
      <div class="btc-meta">🔥${t.heat || '?'}/10 · ${t.count || 0}条</div>
    </div>`;
  }
  html += '</div>';
  container.insertAdjacentHTML('beforeend', html);
}

function renderBriefDiagnosis(d) {
  const reasonIcon = d.reason === 'collection_failed' ? '❌' : d.reason === 'ai_failed' ? '🤖' : '📭';
  const reasonText = d.reason === 'collection_failed' ? '采集失败' : d.reason === 'ai_failed' ? 'AI 分析失败' : d.reason === 'no_posts' ? '玩家暂无发言' : '暂无数据';
  const html = `<div class="brief-topic-notice">${reasonIcon} ${reasonText}</div>`;
  document.getElementById('briefTwitterTopics').innerHTML = html;
  document.getElementById('briefDiscordTopics').innerHTML = html;
}

function renderBriefTopics(data) {
  const twitterTopics = Array.isArray(data) ? data : (data.twitter_topics || []);
  const discordTopics = Array.isArray(data) ? [] : (data.discord_topics || []);
  const sentimentIcon = s => s === 'positive' ? '😊' : s === 'negative' ? '😟' : '😐';
  const sentimentColor = s => s === 'positive' ? '#10b981' : s === 'negative' ? '#ef4444' : '#9ca3af';

  function compactCard(topic) {
    const sColor = sentimentColor(topic.sentiment);
    const sIcon = sentimentIcon(topic.sentiment);
    return `<div class="brief-topic-card" style="border-left:3px solid ${sColor};">
      <div class="btc-title">${sIcon} ${topic.title}</div>
      <div class="btc-meta">🔥${topic.heat || '?'}/10 · ${topic.count || 0}条</div>
    </div>`;
  }

  const twContainer = document.getElementById('briefTwitterTopics');
  const dcContainer = document.getElementById('briefDiscordTopics');
  twContainer.innerHTML = twitterTopics.length > 0
    ? twitterTopics.slice(0, 5).map(compactCard).join('')
    : '<div class="brief-topic-notice">暂无话题</div>';
  dcContainer.innerHTML = discordTopics.length > 0
    ? discordTopics.slice(0, 5).map(compactCard).join('')
    : '<div class="brief-topic-notice">暂无话题</div>';
}

// ===== 原声折叠开关 =====
function toggleBriefMessages() {
  const content = document.getElementById('briefMessagesContent');
  const arrow = document.getElementById('briefMsgArrow');
  if (!content) return;
  const isOpen = content.style.display !== 'none';
  content.style.display = isOpen ? 'none' : 'block';
  if (arrow) arrow.textContent = isOpen ? '▶' : '▼';
}

// 加载话题趋势数据
async function loadTopicTrends(platform) {
  try {
    const response = await fetch(`${API_BASE}/topic-trend?platform=${platform}&days=7`);
    const data = await response.json();
    if (data.ok && data.data) {
      data.data.forEach(topic => {
        const key = `${topic.title}_${topic.history.length > 0 ? 'general' : 'general'}`;
        const latestHistory = topic.history[0];
        if (latestHistory) {
          let trend = 'stable';
          if (topic.history.length >= 2) {
            const prevHeat = topic.history[1].heat || 5;
            const currHeat = latestHistory.heat || 5;
            if (currHeat - prevHeat > 1) trend = 'rising';
            else if (currHeat - prevHeat < -1) trend = 'falling';
          }
          topicTrends[key] = { trend, history: topic.history };
        }
      });
    }
  } catch (error) {
    console.error(`获取${platform}话题趋势失败:`, error);
  }
}

// ===== 玩家发言原声（默认日服Twitter）=====
let currentMsgPlatform = 'twitter';

function switchMsgTab(platform) {
  currentMsgPlatform = platform;
  const twBtn = document.getElementById('msgTabTwitter');
  const dcBtn = document.getElementById('msgTabDiscord');
  if (platform === 'twitter') {
    twBtn.className = 'brief-msg-tab active';
    dcBtn.className = 'brief-msg-tab';
  } else {
    twBtn.className = 'brief-msg-tab';
    dcBtn.className = 'brief-msg-tab active';
  }
  loadPlayerMessages(platform);
}

async function loadPlayerMessages(platform = 'twitter') {
  const container = document.getElementById('playerMessages');
  container.innerHTML = '<div class="loading">加载中...</div>';
  try {
    const res = await fetch(`${API_BASE}/daily?limit=200&platform=${platform}`);
    const result = await res.json();
    if (!result.ok) throw new Error(result.error);
    renderPlayerMessages(result.data, platform);
    document.getElementById('msgCountInfo').textContent = `共 ${result.total} 条发言`;
  } catch (e) {
    container.innerHTML = `<div style="color:var(--color-text-muted,#999);">加载失败: ${e.message}</div>`;
  }
}

function renderPlayerMessages(messages, platform) {
  const container = document.getElementById('playerMessages');
  if (!messages || messages.length === 0) {
    container.innerHTML = '<div style="color:var(--color-text-muted,#999); padding:20px; text-align:center;">暂无发言数据</div>';
    return;
  }
  
  const sentimentIcon = s => s === 'positive' ? '😊' : s === 'negative' ? '😟' : '😐';
  const sentimentColor = s => s === 'positive' ? '#10b981' : s === 'negative' ? '#ef4444' : '#9ca3af';
  const escapeHtml = t => (t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  
  let html = '<div style="display:flex; flex-direction:column; gap:8px;">';
  for (const msg of messages) {
    // Discord 繁中不需要翻译，直接显示原文；Twitter 日文才显示翻译
    const isDiscord = platform === 'discord';
    const content = isDiscord ? (msg.content || '') : (msg.translated_content || msg.content || '');
    const original = (!isDiscord && msg.translated_content && msg.content) ? msg.content : '';
    const sColor = sentimentColor(msg.sentiment);
    const sIcon = sentimentIcon(msg.sentiment);
    const author = msg.author || '匿名';
    const time = msg.created_at ? msg.created_at.substring(5, 16) : '';
    const url = msg.url || '';
    
    html += `<div style="padding:10px 14px; background:var(--color-card-bg,#fff); border:1px solid var(--color-border,#e5e7eb); border-radius:8px; border-left:3px solid ${sColor};">`;
    html += `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">`;
    html += `<span style="font-weight:600; font-size:13px; color:#1a1a1a;">${sIcon} ${escapeHtml(author)}</span>`;
    html += `<span style="font-size:11px; color:#666;">${time}`;
    if (url) html += ` · <a href="${url}" target="_blank" style="color:#3b82f6; text-decoration:none; font-weight:600;">原文↗</a>`;
    html += `</span></div>`;
    html += `<div style="font-size:13px; color:#333; line-height:1.6;">${escapeHtml(content)}</div>`;
    if (original && original !== content) {
      html += `<div style="font-size:11px; color:#888; margin-top:4px; font-style:italic;">原文: ${escapeHtml(original.substring(0,100))}${original.length>100?'...':''}</div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

// ===== 系统运行状态 =====
async function loadSystemStatus() {
  try {
    const res = await fetch('/api/system/status');
    const result = await res.json();
    if (!result.ok) throw new Error(result.error);
    const d = result.data;
    
    // 状态点 + 文字
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const uptime = document.getElementById('statusUptime');
    const errCount = d.errorCount || 0;
    const isHealthy = errCount < 5;
    
    dot.className = 'status-dot ' + (isHealthy ? 'status-ok' : 'status-err');
    text.textContent = isHealthy ? '运行正常' : '有异常';
    uptime.textContent = `已运行 ${d.uptime}`;
    
    // 采集数据
    const twCount = d.collection?.twitter?.lastCount ?? '-';
    const dcCount = d.collection?.discord?.lastCount ?? '-';
    document.getElementById('statusTwitterCount').textContent = twCount;
    document.getElementById('statusDiscordCount').textContent = dcCount;
    // 韩国社区
    const loungeCountEl = document.getElementById('statusLoungeCount');
    if (loungeCountEl) loungeCountEl.textContent = d.collection?.lounge?.lastCount ?? '-';
    
    // 话题
    const topicInfo = d.topicsReady ? `${d.topicCount} 个已就绪` : '未生成';
    document.getElementById('statusTopicInfo').textContent = topicInfo;
    
    // 错误
    const errItem = document.getElementById('statusErrorItem');
    if (errCount > 0) {
      errItem.style.display = '';
      document.getElementById('statusErrorCount').textContent = errCount;
      errItem.title = (d.errors || []).map(e => `[${e.source}] ${e.message}`).join('\n');
    } else {
      errItem.style.display = 'none';
    }
  } catch (e) {
    document.getElementById('statusText').textContent = '状态获取失败';
    document.getElementById('statusDot').className = 'status-dot status-err';
  }
}

// ===== 刷新分析（智能检测 + 触发AI分析） =====
async function refreshAnalysis() {
  const btn = document.getElementById('btnRefreshAnalysis');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '🔄 检测中...';

  try {
    // 第1步：检测是否需要刷新
    const checkRes = await fetch('/api/sentiment/analysis-check');
    const checkResult = await checkRes.json();
    console.log('[刷新分析] 检测结果:', checkResult);

    if (!checkResult.needRefresh) {
      // 不需要刷新，弹窗提醒（warning 更醒目，显示 4 秒）
      btn.disabled = false;
      btn.textContent = '🔄 刷新分析';
      const msg = checkResult.reason || '数据无变化且面板完整，无需刷新分析';
      if (typeof Toast !== 'undefined') Toast.warning(msg);
      else alert(msg);
      return;
    }

    // 第2步：触发分析
    btn.textContent = '🔄 分析中...';
    const res = await fetch('/api/sentiment/refresh-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await res.json();
    console.log('[刷新分析] 分析结果:', result);

    if (result.ok) {
      if (result.needRefresh === false) {
        btn.disabled = false;
        btn.textContent = '🔄 刷新分析';
        if (typeof Toast !== 'undefined') Toast.warning(result.message || '无需刷新');
        else alert(result.message);
        return;
      }
      // 分析已启动，显示加载状态 + 等待完成
      if (typeof Toast !== 'undefined') Toast.success(result.message || 'AI 分析已启动，约 15 秒后刷新');
      const loadingHtml = '<div class="loading">AI 正在分析中，请稍候...</div>';
      // 更新今日快报中的话题区域
      const briefTw = document.getElementById('briefTwitterTopics');
      const briefDc = document.getElementById('briefDiscordTopics');
      if (briefTw) briefTw.innerHTML = loadingHtml;
      if (briefDc) briefDc.innerHTML = loadingHtml;
      // 更新七日热门话题区域
      const weekTw = document.getElementById('weeklyTwitterTopics');
      const weekDc = document.getElementById('weeklyDiscordTopics');
      if (weekTw) weekTw.innerHTML = loadingHtml;
      if (weekDc) weekDc.innerHTML = loadingHtml;
      setTimeout(() => {
        loadAITopics();
        loadStatistics();
        loadDailyFeedback();
        loadHotTopicsBrief();
        loadSystemStatus();
        btn.disabled = false;
        btn.textContent = '🔄 刷新分析';
      }, 15000);
    } else {
      if (typeof Toast !== 'undefined') Toast.error(result.message || '分析失败');
      else alert(result.message || '分析失败');
      btn.disabled = false;
      btn.textContent = '🔄 刷新分析';
    }
  } catch (e) {
    console.error('[刷新分析] 异常:', e);
    if (typeof Toast !== 'undefined') Toast.error('刷新分析失败: ' + e.message);
    else alert('刷新分析失败: ' + e.message);
    btn.disabled = false;
    btn.textContent = '🔄 刷新分析';
  }
}

// 初始化加载数据
function refreshData() {
  loadSystemStatus();
  loadStatistics();
  loadDailyFeedback();
  loadHotTopicsBrief();
  loadPlayerMessages('twitter');
  loadDailySnapshots();
  loadWeeklyOverview();
  loadWeeklyHotTopics();
  loadLoungeBrief();
}

// ===== 加载韩国社区快报 =====
async function loadLoungeBrief() {
  try {
    const res = await fetch('/api/lounge/posts?size=5');
    const result = await res.json();
    if (!result.success) return;
    const container = document.getElementById('briefLoungePosts');
    if (!container) return;
    const posts = result.data || [];
    if (posts.length === 0) {
      container.innerHTML = '<div class="brief-topic-notice">暂无韩国社区数据</div>';
      return;
    }
    let html = '';
    for (const p of posts) {
      const title = p.title_zh || p.title || '';
      const sentIcon = p.sentiment === 'negative' ? '😟' : p.sentiment === 'positive' ? '😊' : '😐';
      const comments = p.comment_count || 0;
      html += `<div class="brief-compact-card">
        <div class="brief-compact-title">${sentIcon} ${escapeHtml(title.length > 30 ? title.substring(0,30)+'...' : title)}</div>
        <div class="brief-compact-meta">👤 ${escapeHtml(p.author || '匿名')} · 💬 ${comments}条评论</div>
      </div>`;
    }
    container.innerHTML = html;
  } catch (e) {
    console.error('加载韩国社区快报失败:', e);
  }
}

// ========== 周报生成功能 ==========
async function generateWeeklyReport() {
  const reportSection = document.getElementById('weeklyReportSection');
  const reportContent = document.getElementById('weeklyReportContent');
  reportSection.style.display = 'block';
  reportContent.innerHTML = '<div class="loading">🤖 AI正在分析上周数据，生成周报中...</div>';
  reportSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const response = await fetch('/api/weekly-report/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || '生成失败');
    const markdown = result.data.report;
    const html = renderMarkdown(markdown);
    reportContent.innerHTML = `
      <div style="margin-bottom: 20px; padding: 15px; background: #f0f9ff; border-left: 4px solid #3b82f6; border-radius: 4px;">
        <strong>📊 报告摘要</strong>
        <p style="margin-top: 8px; color: #1e40af;">${escapeHtml(result.data.summary)}</p>
      </div>
      ${html}
      <div style="margin-top: 30px; text-align: center;">
        <button onclick="downloadReport('${result.data.report.replace(/'/g, "\\'")}');" style="padding: 12px 24px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;">💾 下载报告</button>
      </div>`;
  } catch (error) {
    console.error('❌ 周报生成失败:', error);
    reportContent.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #ef4444;">
        <div style="font-size: 48px; margin-bottom: 16px;">❌</div>
        <h3>周报生成失败</h3>
        <p>${escapeHtml(error.message)}</p>
        <button onclick="generateWeeklyReport()" style="margin-top: 16px; padding: 10px 20px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer;">🔄 重试</button>
      </div>`;
  }
}

function closeWeeklyReport() {
  document.getElementById('weeklyReportSection').style.display = 'none';
}

function renderMarkdown(markdown) {
  let html = markdown
    .replace(/^# (.+)$/gm, '<h1 style="font-size: 24px; font-weight: bold; margin: 24px 0 16px 0; color: #1f2937;">$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size: 20px; font-weight: bold; margin: 20px 0 12px 0; color: #374151;">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size: 18px; font-weight: bold; margin: 16px 0 10px 0; color: #4b5563;">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li style="margin: 8px 0; padding-left: 20px;">$1</li>')
    .replace(/^\|(.+)\|$/gm, (match, content) => {
      const cells = content.split('|').map(cell => cell.trim());
      if (cells.every(cell => /^-+$/.test(cell))) return '';
      return '<tr>' + cells.map(cell => `<td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${cell}</td>`).join('') + '</tr>';
    })
    .replace(/\n\n/g, '</p><p style="margin: 12px 0; line-height: 1.6;">')
    .replace(/^(?!<[hlu]|<tr|<li)(.+)$/gm, '<p style="margin: 12px 0; line-height: 1.6;">$1</p>');
  html = html.replace(/(<tr>.+?<\/tr>)/gs, '<table style="width: 100%; border-collapse: collapse; margin: 16px 0;">$1</table>');
  html = html.replace(/(<li.+?<\/li>)/gs, '<ul style="margin: 12px 0; padding-left: 24px;">$1</ul>');
  return html;
}

function downloadReport(content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const _d = new Date();
  a.download = `舆情周报_${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===== 每日舆情存档 =====

async function loadDailySnapshots() {
  try {
    const res = await fetch(`${API_BASE}/daily-snapshots?days=30`);
    const result = await res.json();
    if (!result.ok) throw new Error(result.error);
    renderSnapshotList(result.data);
  } catch (e) {
    console.error('加载每日存档失败:', e);
    document.getElementById('dailySnapshotList').innerHTML = '<div style="color:var(--color-text-muted,#999);">加载失败</div>';
  }
}

function renderSnapshotList(snapshots) {
  const container = document.getElementById('dailySnapshotList');
  if (!snapshots || snapshots.length === 0) {
    container.innerHTML = '<div style="color:var(--color-text-muted,#999); padding:20px;">暂无存档记录，点击“💾 保存今日存档”生成第一份</div>';
    return;
  }
  let html = '<div style="display:flex; flex-wrap:wrap; gap:10px;">';
  for (const s of snapshots) {
    const aiIcon = s.has_ai_analysis ? '✅' : '⚪';
    const aiText = s.has_ai_analysis
      ? `AI分析: T${s.twitter_topics_count}+D${s.discord_topics_count}`
      : '无AI分析';
    html += `
      <div onclick="viewSnapshotDetail('${s.date}')" style="cursor:pointer; padding:12px 16px; background:var(--color-card-bg,var(--color-surface,#fff)); border:1px solid var(--color-border,#e5e7eb); border-radius:10px; min-width:160px; transition:box-shadow 0.2s;" onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.1)'" onmouseout="this.style.boxShadow='none'">
        <div style="font-weight:bold; font-size:15px; color:var(--color-text,#1f2937);">📅 ${s.date}</div>
        <div style="font-size:12px; color:var(--color-text-secondary,#666); margin-top:4px;">📊 ${s.record_count} 条记录</div>
        <div style="font-size:11px; color:${s.has_ai_analysis ? '#059669' : '#999'}; margin-top:2px;">${aiIcon} ${aiText}</div>
      </div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

async function viewSnapshotDetail(date) {
  document.getElementById('dailySnapshotList').style.display = 'none';
  const detailDiv = document.getElementById('dailySnapshotDetail');
  detailDiv.style.display = 'block';
  document.getElementById('snapshotDetailTitle').textContent = `📅 ${date} 舆情存档`;
  document.getElementById('snapshotDetailContent').innerHTML = '<div class="loading">加载中...</div>';

  try {
    const res = await fetch(`${API_BASE}/daily-snapshots/${date}`);
    const result = await res.json();
    if (!result.ok) throw new Error(result.error);
    renderSnapshotDetail(result.data);
  } catch (e) {
    document.getElementById('snapshotDetailContent').innerHTML = `<div style="color:red;">加载失败: ${e.message}</div>`;
  }
}

function backToSnapshotList() {
  document.getElementById('dailySnapshotList').style.display = 'block';
  document.getElementById('dailySnapshotDetail').style.display = 'none';
}

function renderSnapshotDetail(data) {
  const content = document.getElementById('snapshotDetailContent');
  const ai = data.ai_topics || {};
  const twTopics = (ai.twitter_topics || []).sort((a, b) => (b.heat || 0) - (a.heat || 0));
  const dcTopics = (ai.discord_topics || []).sort((a, b) => (b.heat || 0) - (a.heat || 0));

  // 分成有深度分析的 和 仅关键词统计的
  const twAnalyzed = twTopics.filter(t => t.detail);
  const twBasic = twTopics.filter(t => !t.detail);
  const dcAnalyzed = dcTopics.filter(t => t.detail);
  const dcBasic = dcTopics.filter(t => !t.detail);

  // 统计情绪分布
  const allTopics = [...twTopics, ...dcTopics];
  const neg = allTopics.filter(t => t.sentiment === 'negative').length;
  const pos = allTopics.filter(t => t.sentiment === 'positive').length;
  const neu = allTopics.filter(t => t.sentiment === 'neutral').length;

  let html = '';

  // === 顶部总览 ===
  html += `<div style="display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap;">
    <div style="flex:1; min-width:120px; padding:14px 16px; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; border-radius:10px;">
      <div style="font-size:24px; font-weight:bold;">${data.record_count}</div>
      <div style="font-size:12px; opacity:0.8;">条玩家发言</div>
    </div>
    <div style="flex:1; min-width:120px; padding:14px 16px; background:linear-gradient(135deg,#f093fb,#f5576c); color:#fff; border-radius:10px;">
      <div style="font-size:24px; font-weight:bold;">${twTopics.length + dcTopics.length}</div>
      <div style="font-size:12px; opacity:0.8;">个话题 (TW:${twTopics.length} DC:${dcTopics.length})</div>
    </div>
    <div style="flex:1; min-width:120px; padding:14px 16px; background:linear-gradient(135deg,#4facfe,#00f2fe); color:#fff; border-radius:10px;">
      <div style="font-size:24px; font-weight:bold;">${neg > 0 ? '⚠️ ' + neg : '✅ ' + neg}</div>
      <div style="font-size:12px; opacity:0.8;">负面话题</div>
    </div>
    <div style="flex:1; min-width:120px; padding:14px 16px; background:linear-gradient(135deg,#43e97b,#38f9d7); color:#fff; border-radius:10px;">
      <div style="font-size:24px; font-weight:bold;">${twAnalyzed.length + dcAnalyzed.length}</div>
      <div style="font-size:12px; opacity:0.8;">个AI深度分析</div>
    </div>
  </div>`;

  if (twTopics.length === 0 && dcTopics.length === 0) {
    html += '<div style="padding:30px; color:var(--color-text-muted,#999); text-align:center; font-size:15px;">当天无 AI 分析存档<br><span style="font-size:12px;">热门话题当天未被访问过，或当天无采集数据</span></div>';
  } else {
    // === 双平台并排展示 ===
    html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;">';

    // Twitter 列
    html += '<div>';
    html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:12px; padding-bottom:8px; border-bottom:2px solid #1d9bf0;">
      <span style="font-size:18px;">🐦</span>
      <span style="font-weight:bold; font-size:15px; color:#1d9bf0;">日服 Twitter</span>
      <span style="font-size:12px; color:var(--color-text-muted,#999); margin-left:auto;">${twTopics.length} 个话题</span>
    </div>`;
    if (twAnalyzed.length > 0) {
      twAnalyzed.slice(0, 5).forEach(t => { html += renderSnapshotCard(t); });
    }
    if (twBasic.length > 0 && twAnalyzed.length === 0) {
      html += '<div style="font-size:12px; color:var(--color-text-muted,#999); margin-bottom:8px;">ℹ️ 当天仅有关键词统计，无AI深度分析</div>';
      twBasic.slice(0, 5).forEach(t => { html += renderSnapshotCard(t); });
    }
    if (twTopics.length === 0) {
      html += '<div style="padding:16px; color:var(--color-text-muted,#ccc); text-align:center;">当天无数据</div>';
    }
    html += '</div>';

    // Discord 列
    html += '<div>';
    html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:12px; padding-bottom:8px; border-bottom:2px solid #5865f2;">
      <span style="font-size:18px;">💬</span>
      <span style="font-weight:bold; font-size:15px; color:#5865f2;">繁中 Discord</span>
      <span style="font-size:12px; color:var(--color-text-muted,#999); margin-left:auto;">${dcTopics.length} 个话题</span>
    </div>`;
    if (dcAnalyzed.length > 0) {
      dcAnalyzed.slice(0, 5).forEach(t => { html += renderSnapshotCard(t); });
    }
    if (dcBasic.length > 0 && dcAnalyzed.length === 0) {
      html += '<div style="font-size:12px; color:var(--color-text-muted,#999); margin-bottom:8px;">ℹ️ 当天仅有关键词统计，无AI深度分析</div>';
      dcBasic.slice(0, 5).forEach(t => { html += renderSnapshotCard(t); });
    }
    if (dcTopics.length === 0) {
      html += '<div style="padding:16px; color:var(--color-text-muted,#ccc); text-align:center;">当天无数据</div>';
    }
    html += '</div>';

    html += '</div>'; // grid end

    // === 其他话题折叠 ===
    const otherTopics = [...twBasic, ...dcBasic];
    if (otherTopics.length > 0 && (twAnalyzed.length > 0 || dcAnalyzed.length > 0)) {
      html += `<details style="margin-top:16px;">
        <summary style="cursor:pointer; font-size:13px; color:var(--color-text-muted,#999); padding:8px 0;">📝 其他关键词统计话题 (${otherTopics.length}个，无AI深度分析)</summary>
        <div style="display:flex; flex-wrap:wrap; gap:6px; padding:8px 0;">`;
      for (const t of otherTopics.slice(0, 20)) {
        const sColor = t.sentiment === 'negative' ? '#fecaca' : t.sentiment === 'positive' ? '#bbf7d0' : '#e5e7eb';
        const pIcon = t.title ? '' : '';
        html += `<span style="font-size:11px; padding:3px 10px; background:${sColor}; border-radius:12px; color:var(--color-text-secondary,#555);">${t.title} (${t.count || 0}条, 热度${t.heat})</span>`;
      }
      html += '</div></details>';
    }
  }

  content.innerHTML = html;
}

function renderSnapshotCard(t) {
  const sentimentColor = t.sentiment === 'negative' ? '#ef4444' : t.sentiment === 'positive' ? '#22c55e' : '#6b7280';
  const sentimentText = t.sentiment === 'negative' ? '😞 负面' : t.sentiment === 'positive' ? '😊 正面' : '😐 中性';
  const hasAnalysis = !!t.detail;

  let html = `<div style="margin-bottom:10px; padding:12px; background:var(--color-card-bg,var(--color-surface,#fff)); border:1px solid var(--color-border,#e5e7eb); border-radius:10px; ${hasAnalysis ? 'border-left:3px solid ' + sentimentColor + ';' : ''}">`;

  // 标题行
  html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">
    <span style="font-weight:bold; font-size:14px; color:var(--color-text,#1f2937);">${t.title}</span>
    <span style="font-size:10px; padding:2px 8px; background:${sentimentColor}15; color:${sentimentColor}; border-radius:10px; font-weight:600;">${sentimentText}</span>
    <span style="font-size:10px; color:var(--color-text-muted,#999);">🔥${t.heat}/10 · ${t.count}条讨论</span>
  </div>`;

  // 深度分析（有则展示）
  if (t.detail) {
    html += `<div style="font-size:13px; color:var(--color-text,#334155); line-height:1.6; margin-bottom:8px;">${t.detail}</div>`;
  } else if (t.summary) {
    html += `<div style="font-size:13px; color:var(--color-text-secondary,#666); line-height:1.5; margin-bottom:8px;">${t.summary}</div>`;
  }

  // 玩家原声
  if (t.representative_quotes && t.representative_quotes.length > 0) {
    html += '<div style="margin-bottom:6px;">';
    t.representative_quotes.forEach(q => {
      const text = typeof q === 'object' ? q.text : q;
      const time = typeof q === 'object' ? q.created_at : '';
      html += `<div style="font-size:12px; color:#92400e; padding:4px 10px; background:var(--color-surface-raised,#fffbeb); border-left:3px solid #f59e0b; margin:4px 0; border-radius:0 4px 4px 0; line-height:1.5;">
        “${text}” ${time ? `<span style="float:right; color:var(--color-text-muted,#999); font-size:11px;">${time}</span>` : ''}
      </div>`;
    });
    html += '</div>';
  }

  // 建议
  if (t.action) {
    html += `<div style="font-size:11px; color:#7c3aed; padding:4px 10px; background:var(--color-surface-raised,#f5f3ff); border-radius:6px;">💡 ${t.action}</div>`;
  }

  html += '</div>';
  return html;
}

async function saveTodaySnapshot() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ 保存中...';
  try {
    const res = await fetch(`${API_BASE}/save-daily-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: (() => { const d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })() })
    });
    const result = await res.json();
    if (result.ok) {
      alert(`✅ 存档成功！\n日期: ${result.date}\n记录: ${result.count} 条\nAI话题: Twitter ${result.ai_topics?.twitter || 0} 个, Discord ${result.ai_topics?.discord || 0} 个`);
      loadDailySnapshots();
    } else {
      alert('❌ 保存失败: ' + (result.message || result.error));
    }
  } catch (e) {
    alert('❌ 保存异常: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 保存今日存档';
  }
}

// 页面加载时初始化
window.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 [v2.0] 舆情面板加载...');
  refreshData();
  // 每 60 秒刷新系统状态
  setInterval(loadSystemStatus, 60 * 1000);
  // 每 30 分钟自动刷新数据
  setInterval(() => { loadStatistics(); loadDailyFeedback(); }, 30 * 60 * 1000);
});

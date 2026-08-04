const db = require('./db');

// 内联清洗函数（和 routes/lounge.js 里的一样）
function cleanLoungeContent(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/\d{2,4}[.\/\-]\d{1,2}[.\/\-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, ' ');
  t = t.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');
  t = t.replace(/(?:作者|작성자|writer|author)\s*[:：]?\s*\S{1,10}/gi, ' ');
  t = t.replace(/\b(?:buff|nerf|버프|너프|추천|비추천|공감|비공감)\b/g, ' ');
  const lines = t.split('\n');
  const cleaned = [];
  let prevLine = '';
  let repeatCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === prevLine && trimmed.length < 50) {
      repeatCount++;
      if (repeatCount <= 2) cleaned.push(trimmed);
    } else {
      repeatCount = 0;
      if (trimmed) cleaned.push(trimmed);
    }
    prevLine = trimmed;
  }
  t = cleaned.join('\n');
  t = t.split('\n').filter(l => l.trim().length >= 3).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// 更激进的清洗：去掉页面导航/页脚等固定噪音
function deepClean(text) {
  if (!text) return '';
  let t = text;
  
  // 去掉页面头部导航（"닫기트리 오브 세이비어...라운지 가기"等）
  t = t.replace(/^[^]*?(?:💖||🌿||🎮|❄️|🔥|✨|🌊)/s, '$&');
  
  // 去掉 "닫기" 开头到第一个正文标记之间的导航文字
  const navEnd = t.indexOf('용사 여러분') || t.indexOf('GM 티메이') || t.indexOf('勇士们') || t.indexOf('GM蒂梅');
  if (navEnd > 0 && navEnd < 500) {
    // 保留从正文开始的内容
    t = t.substring(navEnd);
  }
  
  // 去掉页尾（NAVER Corp 之后的一切）
  t = t.replace(/[\s\S]*(?:NAVER Corp|Naver使用条款|个人信息处理政策|개인정보 처리방침)[\s\S]*/i, '');
  
  // 去掉 "GM 티메이 님의 최신 글" 和 "더보기" 之后的其他帖子列表
  t = t.replace(/(?:GM 티메이 님의 최신 글|GM蒂梅的最新帖子)[\s\S]*/i, '');
  t = t.replace(/더보기[\s\S]*?(?:댓글|버프|조회수)/g, '');
  
  // 去掉 "댓글" 之后的评论区
  t = t.replace(/(?:댓글|评论)\s*\d+[\s\S]*/g, '');
  
  // 去掉 "조회수" 行
  t = t.replace(/조회수\s*\d+/g, '');
  t = t.replace(/浏览\s*\d+/g, '');
  
  // 基础清洗
  t = cleanLoungeContent(t);
  
  return t.trim();
}

(async () => {
  await db.initDb();
  const posts = db.queryAll("SELECT post_id, content, content_zh, length(content) as len FROM lounge_posts ORDER BY crawled_at DESC");
  console.log('总帖子数:', posts.length);
  
  let cleaned = 0;
  for (const p of posts) {
    if (p.len < 50) continue; // 跳过空内容
    
    const cleanKr = deepClean(p.content);
    const cleanZh = p.content_zh ? deepClean(p.content_zh) : null;
    
    if (cleanKr !== p.content || (cleanZh && cleanZh !== p.content_zh)) {
      db.getDb().run(
        "UPDATE lounge_posts SET content = ?, content_zh = ? WHERE post_id = ?",
        [cleanKr || null, cleanZh || null, p.post_id]
      );
      cleaned++;
      console.log(`  ✅ ${p.post_id}: ${p.len}字 → ${cleanKr.length}字`);
    }
  }
  db.saveDb();
  console.log('\n清理完成:', cleaned, '条');
  
  // 验证
  const check = db.queryOne(
    "SELECT substr(content,1,200) as c, length(content) as len FROM lounge_posts WHERE post_id = '8006713'"
  );
  console.log('\n验证 8006713:');
  console.log(check.c);
  console.log('长度:', check.len);
  
  // 检查评论
  const comments = db.queryAll(
    "SELECT post_id, substr(content,1,60) as c, author FROM lounge_comments LIMIT 5"
  );
  console.log('\n评论数据:');
  console.log(JSON.stringify(comments, null, 2));
  
  process.exit(0);
})();

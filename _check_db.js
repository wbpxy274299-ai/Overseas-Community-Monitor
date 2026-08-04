const db = require('./db');
(async () => {
  await db.initDb();
  const posts = db.queryAll("SELECT post_id, length(content) as len, substr(content,1,80) as preview FROM lounge_posts ORDER BY crawled_at DESC LIMIT 5");
  console.log(JSON.stringify(posts, null, 2));
  
  const total = db.queryOne("SELECT COUNT(*) as cnt, SUM(CASE WHEN content IS NULL OR content = '' THEN 1 ELSE 0 END) as empty_cnt FROM lounge_posts");
  console.log('\n总帖子数:', total.cnt, ', 空内容:', total.empty_cnt);
  
  process.exit(0);
})();

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { recrawlPost } = require('./lounge_crawler');
const db = require('./db');

(async () => {
  await db.initDb();
  console.log('测试重爬帖子 8006713...');
  const result = await recrawlPost('8006713');
  console.log('结果:', JSON.stringify(result, null, 2));

  // 验证数据库
  const post = db.queryOne("SELECT substr(content,1,200) as c, length(content) as len FROM lounge_posts WHERE post_id = '8006713'");
  console.log('\n数据库 content 前200字:', post?.c || '(空)');
  console.log('长度:', post?.len || 0);

  const comments = db.queryAll("SELECT author, substr(content,1,60) as c FROM lounge_comments WHERE post_id = '8006713'");
  console.log('\n评论:', JSON.stringify(comments, null, 2));

  process.exit(0);
})();

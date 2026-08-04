/**
 * 批量重爬所有 Lounge 帖子（用修复后的选择器）
 * 用法: node _recrawl_all.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { recrawlPost } = require('./lounge_crawler');
const db = require('./db');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await db.initDb();
  
  const posts = db.queryAll(
    "SELECT post_id FROM lounge_posts WHERE url IS NOT NULL AND url != '' ORDER BY crawled_at DESC"
  );
  console.log(`待重爬帖子: ${posts.length} 条\n`);
  
  let success = 0, fail = 0;
  
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    console.log(`[${i + 1}/${posts.length}] 重爬 ${p.post_id}...`);
    
    const result = await recrawlPost(p.post_id);
    if (result.success) {
      success++;
      console.log(`  ✅ 正文 ${result.detail?.content?.length || 0}字, 评论 ${result.detail?.comments || 0}条`);
    } else {
      fail++;
      console.log(`  ❌ ${result.message}`);
    }
    
    // 每次抓取间隔 3 秒，避免被 Naver 封
    if (i < posts.length - 1) await sleep(3000);
  }
  
  console.log(`\n完成！成功: ${success}, 失败: ${fail}`);
  
  // 验证
  const check = db.queryOne(
    "SELECT substr(content,1,100) as c, length(content) as len FROM lounge_posts WHERE post_id = '8006713'"
  );
  console.log('\n验证 8006713:');
  console.log(check?.c || '(空)');
  console.log('长度:', check?.len || 0);
  
  const comments = db.queryAll(
    "SELECT substr(content,1,60) as c, author, comment_time FROM lounge_comments WHERE post_id = '8006713'"
  );
  console.log('\n8006713 评论:');
  console.log(JSON.stringify(comments, null, 2));
  
  process.exit(0);
})();

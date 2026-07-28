/**
 * 数据提取脚本 - Node.js 版本
 * 从原始 HTML 中提取 TERMS 数组，导出为 JSON
 * 运行方式: node scripts/extract_data.js
 */

const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, '..', '术语校对工具_多语言聚合版.html');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'terms.json');

console.log('正在读取原始 HTML 文件...');

fs.readFile(INPUT_FILE, 'utf-8', (err, content) => {
  if (err) {
    console.error('错误：无法读取文件', err.message);
    process.exit(1);
  }

  console.log('正在提取 TERMS 数据...');
  
  const match = content.match(/TERMS\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) {
    console.error('错误：未找到 TERMS 数组');
    process.exit(1);
  }

  try {
    const data = JSON.parse(match[1]);
    console.log(`提取到 ${data.length} 条术语`);

    // 清理数据：去掉尾部的空字符串
    const cleaned = data.map(row => {
      while (row.length > 1 && (row[row.length - 1] === '' || row[row.length - 1] === null)) {
        row.pop();
      }
      return row;
    });

    // 确保输出目录存在
    const outputDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 写入 JSON 文件
    fs.writeFile(OUTPUT_FILE, JSON.stringify(cleaned, null, 0), 'utf-8', (err) => {
      if (err) {
        console.error('错误：无法写入文件', err.message);
        process.exit(1);
      }

      const stats = fs.statSync(OUTPUT_FILE);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      
      console.log(`已导出到: ${OUTPUT_FILE}`);
      console.log(`文件大小: ${sizeMB} MB`);
      console.log('完成！');
    });

  } catch (e) {
    console.error('错误：JSON 解析失败', e.message);
    process.exit(1);
  }
});

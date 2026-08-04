const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'views');

const pages = ['sentiment.html', 'reports.html', 'insights.html', 'terminology.html', 'post-assistant.html', 'admin.html', 'sentiment-history.html'];

pages.forEach(f => {
  const fp = path.join(dir, f);
  let c = fs.readFileSync(fp, 'utf8');
  
  // 1. Remove old CSS references (keep only m2g-theme.css and CDN scripts)
  c = c.replace(/<link rel="stylesheet" href="\/static\/css\/base\.css">\s*\n?/g, '');
  c = c.replace(/<link rel="stylesheet" href="\/static\/css\/components\.css">\s*\n?/g, '');
  c = c.replace(/<link rel="stylesheet" href="\/static\/css\/pages\/[^"]+">\s*\n?/g, '');
  c = c.replace(/<link rel="stylesheet" href="\/static\/style\.css">\s*\n?/g, '');
  
  // 2. Add data-theme="light" to <html> if not present
  if (!c.includes('data-theme=')) {
    c = c.replace(/<html lang="[^"]*">/, m => m.replace('>', ' data-theme="light">'));
  }
  
  // 3. Replace old header structure with compact page-head
  // Match: <header class="app-header">...<nav ... id="mainNav"></nav>...</header>
  const headerRegex = /<header class="app-header">\s*<div class="app-header-inner">\s*<div class="header-left">\s*<h1>([^<]*)<\/h1>\s*<p>([^<]*)<\/p>\s*<\/div>\s*<nav[^>]*id="mainNav"[^>]*><\/nav>\s*<\/div>\s*<\/header>/s;
  c = c.replace(headerRegex, (match, h1Text, pText) => {
    // Extract emoji and text
    const cleanTitle = h1Text.replace(/^[\u{1F300}-\u{1F9FF}]\s*/u, '').trim();
    const pageHeadHtml = `<div class="wrap page-head" style="padding:36px 0 20px">
    <div class="micro">${cleanTitle}</div>
    <div class="huge" style="font-size:clamp(26px,3.2vw,40px);line-height:1.15;margin:8px 0 16px">${cleanTitle.split('·')[0].split('-')[0].trim()}</div>
  </div>`;
    return pageHeadHtml;
  });
  
  // 4. Replace .container with .wrap
  c = c.replace(/<div class="container">/g, '<div class="wrap">');
  c = c.replace(/<\/div><!-- \/\.container -->/g, '</div><!-- /.wrap -->');
  
  fs.writeFileSync(fp, c);
  console.log('OK ' + f);
});

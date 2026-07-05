const http = require('http');

console.log('=== Google SSO 完整诊断 ===\n');

// 测试1: 检查 /api/auth/google/login API
console.log('[测试1] 检查 /api/auth/google/login API...');
const req1 = http.get('http://localhost:5000/api/auth/google/login', (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('状态码:', res.statusCode);
    
    try {
      const json = JSON.parse(data);
      console.log('✅ API 返回 JSON');
      
      if (json.authUrl) {
        const url = new URL(json.authUrl);
        const clientId = url.searchParams.get('client_id');
        const redirectUri = url.searchParams.get('redirect_uri');
        
        console.log('\nclient_id:', clientId || '❌ 空');
        console.log('redirect_uri:', redirectUri || '❌ 空');
        
        if (!clientId || !redirectUri) {
          console.log('\n❌ 问题：client_id 或 redirect_uri 为空');
          console.log('   可能原因：环境变量未正确加载');
        } else {
          console.log('\n✅ API 配置正确');
        }
      } else {
        console.log('❌ 响应中没有 authUrl');
        console.log('响应内容:', data);
      }
    } catch (e) {
      console.log('❌ 响应不是 JSON');
      console.log('响应内容:', data.substring(0, 200));
    }
    
    // 测试2: 检查登录页面
    console.log('\n[测试2] 检查 /google-login 页面...');
    const req2 = http.get('http://localhost:5000/google-login', (res2) => {
      let data2 = '';
      
      res2.on('data', (chunk) => {
        data2 += chunk;
      });
      
      res2.on('end', () => {
        console.log('状态码:', res2.statusCode);
        console.log('Content-Type:', res2.headers['content-type']);
        
        if (res2.statusCode === 200 && data2.includes('Google')) {
          console.log('✅ 登录页面正常');
        } else {
          console.log('❌ 登录页面异常');
        }
        
        console.log('\n=== 诊断完成 ===');
      });
    });
    
    req2.on('error', (err) => {
      console.error('❌ 登录页面请求失败:', err.message);
    });
    
    req2.end();
  });
});

req1.on('error', (err) => {
  console.error('❌ API 请求失败:', err.message);
  console.log('\n请确认服务器已启动：node server.js');
});

req1.end();

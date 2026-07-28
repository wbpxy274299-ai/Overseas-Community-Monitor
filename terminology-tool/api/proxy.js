// Vercel Serverless Function - API Proxy
// Supports both Gemini API and AI Studio API

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export default async function handler(request, response) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return response.status(200).end();
  }

  // Only accept POST
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { type, question, code, version, apiKey, image } = request.body;

    if (type === 'gemini') {
      // Call Gemini API
      const geminiApiKey = process.env.GEMINI_API_KEY || '';
      const model = 'gemini-2.0-flash-exp';
      
      if (!geminiApiKey) {
        return response.status(500).json({ 
          success: false, 
          errorMsg: 'Gemini API Key not configured. Set GEMINI_API_KEY in Vercel environment variables.' 
        });
      }

      const apiUrl = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${geminiApiKey}`;
      
      // 构建请求内容，支持图片和文本
      const parts = [];
      
      // 如果有图片，添加图片数据
      if (image && image.data) {
        parts.push({
          inline_data: {
            mime_type: image.mimeType || 'image/jpeg',
            data: image.data
          }
        });
      }
      
      // 添加文本
      parts.push({ text: question });
      
      const geminiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: parts
          }]
        })
      });

      const data = await geminiResponse.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return response.status(200).json({
        success: true,
        data: { content: text }
      });

    } else if (type === 'aistudio') {
      // Call AI Studio API
      const aiStudioAK = process.env.AI_STUDIO_AK || '';
      
      if (!aiStudioAK) {
        return response.status(500).json({ 
          success: false, 
          errorMsg: 'AI Studio AK not configured. Set AI_STUDIO_AK in Vercel environment variables.' 
        });
      }

      if (!code || !question) {
        return response.status(400).json({ error: 'Missing required fields' });
      }

      const url = `https://aistudio.alibaba-inc.com/api/aiapp/run/${code}/${version || '1.0.0'}`;

      const aiResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'X-AK': aiStudioAK,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          empId: '000000',
          question: question,
          sessionId: 'vf-' + Date.now(),
          stream: false
        })
      });

      const data = await aiResponse.json();

      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return response.status(200).json(data);
    } else {
      return response.status(400).json({ error: 'Invalid type. Use "gemini" or "aistudio"' });
    }

  } catch (error) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    return response.status(500).json({
      success: false,
      errorMsg: error.message || 'Proxy error'
    });
  }
}

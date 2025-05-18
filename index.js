const express = require("express");
const { exec } = require("child_process");
const fs = require('fs');
const path = require('path');

// 读取 .env.local 配置
let targetHost = 'localhost:3000'; // 默认值
try {
  const envPath = path.join(__dirname, '.env.local');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const envConfig = Object.fromEntries(
    envContent.split('\n')
      .filter(line => line.trim())
      .map(line => line.split('='))
  );
  if (envConfig['walrus-portal-host']) {
    targetHost = envConfig['walrus-portal-host'];
  }
} catch (err) {
  console.warn('无法读取 .env.local 文件，使用默认主机配置');
}

const app = express();

// 添加body解析中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 辅助函数：从host中提取子域名
function extractSubdomain(host) {
  if (!host) return null;
  // 移除端口号
  const hostname = host.split(":")[0];
  // 检查是否是 .localhost 结尾
  if (hostname.endsWith(".localhost")) {
    return hostname.slice(0, -9); // 移除 .localhost
  }
  return null;
}

// 辅助函数：清理和验证 HTTP 头
function sanitizeHeader(key, value) {
  // 移除不可见字符
  const sanitizedValue = value.replace(/[\x00-\x1F\x7F]/g, '');
  
  // 检查头名称是否合法
  if (!/^[\w-]+$/.test(key)) {
    return null;
  }
  
  // 跳过可能导致问题的头
  const skipHeaders = ['content-encoding', 'transfer-encoding', 'connection'];
  if (skipHeaders.includes(key.toLowerCase())) {
    return null;
  }
  
  return { key, value: sanitizedValue };
}

// 中间件：转发所有请求
app.use((req, res) => {
  const subdomain = extractSubdomain(req.headers.host) || req.headers["x-subdomain"];

  if (!subdomain) {
    return res.status(400).json({
      error: "Subdomain is required",
      message: "Please access via subdomain.localhost:3005 or provide X-Subdomain header",
    });
  }

  // 修改目标URL构建部分
  const targetUrl = `http://${subdomain}.${targetHost}${req.url}`;

  const curlCommand = `curl -X ${req.method} \
    -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7" \
    -H "Accept-Language: zh-CN,zh;q=0.9" \
    -H "Cache-Control: max-age=0" \
    -H "Connection: keep-alive" \
    -H "Host: ${subdomain}.localhost:3005" \
    -H "Sec-Fetch-Dest: document" \
    -H "Sec-Fetch-Mode: navigate" \
    -H "Sec-Fetch-Site: cross-site" \
    -H "Sec-Fetch-User: ?1" \
    -H "Upgrade-Insecure-Requests: 1" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36" \
    -H "sec-ch-ua: Chromium;v=136, Google Chrome;v=136, Not.A/Brand;v=99" \
    -H "sec-ch-ua-mobile: ?0" \
    -H "sec-ch-ua-platform: macOS" \
    -H "X-Forwarded-Host: ${req.headers.host}" \
    -H "X-Forwarded-For: ${req.ip}" \
    -H "X-Real-IP: ${req.ip}" \
    -H "X-Subdomain: ${subdomain}" \
    --resolve ${subdomain}.localhost:3005:127.0.0.1 \
    -i \
    "${targetUrl}"`;

  exec(curlCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
    if (error) {
      console.error("Proxy error:", error);
      return res.status(503).json({
        error: "Target service is not available",
        details: `Failed to connect to ${subdomain}.localhost:3005`,
        code: error.code
      });
    }

    try {
      const [headers, ...body] = stdout.split('\r\n\r\n');
      const statusLine = headers.split('\n')[0];
      const statusCode = parseInt(statusLine.split(' ')[1]) || 200;

      // 处理响应头
      headers.split('\n').slice(1).forEach(header => {
        const [key, ...value] = header.split(': ');
        if (key && value.length > 0) {
          const sanitized = sanitizeHeader(key.trim(), value.join(': ').trim());
          if (sanitized) {
            res.set(sanitized.key, sanitized.value);
          }
        }
      });

      res.status(statusCode).send(body.join('\r\n\r\n'));
    } catch (err) {
      console.error('Error processing response:', err);
      res.status(502).json({
        error: 'Bad Gateway',
        message: 'Error processing target server response'
      });
    }
  });
});

app.listen(8000, () => {
  console.log("Proxy server is running on port 8000");
});

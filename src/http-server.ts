import express from 'express';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Server } from 'http';
import os from 'os';
import cors from 'cors';

// 創建一個函數來設置 HTTP 服務器
export async function setupHttpServer(server: McpServer, port: number = 3000): Promise<void> {
  const app = express();
  
  // 添加 CORS 支援，允許跨域請求
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'mcp-session-id']
  }));
  
  app.use(express.json());

  // 用於存儲按會話 ID 的傳輸映射
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // 處理 POST 請求，用於客戶端到服務器的通信
  app.post('/mcp', async (req: Request, res: Response) => {
    // 檢查現有的會話 ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // 重用現有的傳輸
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // 新的初始化請求
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          // 按會話 ID 存儲傳輸
          transports[newSessionId] = transport;
        }
      });

      // 當關閉時清理傳輸
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      // 連接到 MCP 服務器
      await server.connect(transport);
    } else {
      // 無效的請求
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: '錯誤請求：未提供有效的會話 ID',
        },
        id: null,
      });
      return;
    }

    // 處理請求
    await transport.handleRequest(req, res, req.body);
  });

  // 用於 GET 和 DELETE 請求的可重用處理程序
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('無效或缺少會話 ID');
      return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  // 處理 GET 請求，用於通過 SSE 的服務器到客戶端通知
  app.get('/mcp', handleSessionRequest);

  // 處理 DELETE 請求，用於會話終止
  app.delete('/mcp', handleSessionRequest);

  // 添加一個簡單的健康檢查端點
  app.get('/health', (req: Request, res: Response) => {
    // 取得網絡接口信息
    const networkInterfaces = os.networkInterfaces();
    const addresses: string[] = [];
    
    // 收集所有非內部的 IPv4 地址
    Object.keys(networkInterfaces).forEach((ifname) => {
      const interfaces = networkInterfaces[ifname];
      if (interfaces) {
        interfaces.forEach((iface) => {
          if (iface.family === 'IPv4' && !iface.internal) {
            addresses.push(iface.address);
          }
        });
      }
    });
    
    res.status(200).json({ 
      status: 'ok',
      serverTime: new Date().toISOString(),
      networkAddresses: addresses,
      hostname: os.hostname(),
      port: port
    });
  });
  
  // 添加一個根路徑的端點，提供基本信息
  app.get('/', (req: Request, res: Response) => {
    res.status(200).send(`
      <html>
        <head>
          <title>Langfuse Prompts MCP Server</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
            h1 { color: #333; }
            pre { background: #f4f4f4; padding: 10px; border-radius: 5px; }
            .endpoint { font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>Langfuse Prompts MCP Server</h1>
          <p>MCP Server 正在運行中。使用以下端點進行連接：</p>
          <p class="endpoint">MCP 端點： <code>http://localhost:${port}/mcp</code> 或 <code>http://127.0.0.1:${port}/mcp</code></p>
          <p>如果使用 MCP Inspector，請嘗試使用 IP 地址而不是主機名稱：</p>
          <pre>http://127.0.0.1:${port}/mcp</pre>
          <p>健康檢查端點： <a href="/health">/health</a></p>
        </body>
      </html>
    `);
  });

  // 嘗試啟動服務器並處理可能的錯誤
  // 使用 '0.0.0.0' 綁定到所有網絡接口，以確保服務器可以被外部訪問
  const httpServer: Server = app.listen(port, '0.0.0.0', () => {
    console.error(`Langfuse Prompts MCP Server running on HTTP port ${port}`);
    console.error(`可以通過 http://127.0.0.1:${port}/mcp 或 http://localhost:${port}/mcp 訪問`);
  }).on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`錯誤：端口 ${port} 已被占用。請嘗試使用不同的端口，例如：--port=3001`);
      process.exit(1);
    } else {
      console.error(`啟動服務器時發生錯誤：`, err);
      process.exit(1);
    }
  });
  
  // 處理進程終止信號
  process.on('SIGINT', () => {
    console.error('收到 SIGINT 信號，正在關閉服務器...');
    httpServer.close(() => {
      console.error('服務器已安全關閉');
      process.exit(0);
    });
  });
  
  process.on('SIGTERM', () => {
    console.error('收到 SIGTERM 信號，正在關閉服務器...');
    httpServer.close(() => {
      console.error('服務器已安全關閉');
      process.exit(0);
    });
  });
}

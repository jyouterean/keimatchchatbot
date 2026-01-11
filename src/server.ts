import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebhookEvent } from '@line/bot-sdk';
import { lineMiddleware, handleLineWebhook } from './lib/lineHandlers';
import { generateAnswer } from './lib/qaAnswer';
import { reloadIndex, indexExists } from './lib/indexStore';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// CORS設定
app.use(cors());

// LINE Webhook用の生ボディパーサー（署名検証のため）
// 注意: express.json() を /webhook より前にグローバル適用しない
app.use(
  '/webhook',
  express.raw({ type: 'application/json' }),
  lineMiddleware
);

// その他のルート用のJSONパーサー
app.use(express.json());

/**
 * ヘルスチェック
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    indexLoaded: indexExists(),
  });
});

/**
 * チャットAPI
 */
app.post('/chat', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'Message is required and must be a non-empty string',
      });
    }

    const response = await generateAnswer(message);
    res.json(response);
  } catch (error) {
    console.error('Error in /chat:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/**
 * LINE Webhook
 * LINE SDKミドルウェアが署名検証とパースを実行済み
 */
app.post('/webhook', async (req: Request, res: Response) => {
  try {
    // LINE SDKミドルウェアが署名検証とパースを実行済み
    const body = req.body as { events?: WebhookEvent[] };
    const events: WebhookEvent[] = body.events || [];

    if (events.length === 0) {
      // イベントがない場合は200を返す
      return res.status(200).send('OK');
    }

    // イベント処理（非同期で実行、エラーは内部で処理）
    handleLineWebhook(events).catch((error) => {
      console.error('Unhandled error in webhook handler:', error);
    });

    // LINEサーバーには即座に200を返す
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error in /webhook:', error);
    // 署名検証エラーなどはミドルウェアが処理済み
    // ここに来る場合は予期しないエラー
    res.status(500).send('Internal server error');
  }
});

/**
 * 管理API: インデックス再読み込み
 */
app.post('/admin/reload', async (req: Request, res: Response) => {
  const adminToken = process.env.ADMIN_TOKEN;

  // ADMIN_TOKENが設定されている場合は認証を要求
  if (adminToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const token = authHeader.substring(7);
    if (token !== adminToken) {
      return res.status(403).json({ error: 'Invalid token' });
    }
  }

  try {
    const index = reloadIndex();
    res.json({
      success: true,
      message: 'Index reloaded',
      count: index.count,
      generatedAt: index.generatedAt,
    });
  } catch (error) {
    console.error('Error reloading index:', error);
    const message = error instanceof Error ? error.message : 'Failed to reload index';
    res.status(500).json({ error: message });
  }
});

/**
 * エラーハンドリング
 */
app.use((err: Error, req: Request, res: Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * サーバー起動
 */
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  
  // 起動時にインデックスの存在をチェック
  if (indexExists()) {
    console.log('✓ Q&A index found');
  } else {
    console.warn('⚠ Q&A index not found. Please run "npm run sync" first.');
  }
});


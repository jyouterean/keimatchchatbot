import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebhookEvent } from '@line/bot-sdk';
import { lineMiddleware, staffLineMiddleware, staffWebhookClient, handleLineWebhook } from './lib/lineHandlers';
import { generateAnswer } from './lib/qaAnswer';
import { reloadIndex, indexExists } from './lib/indexStore';
import { log, startTimer } from './lib/logger';

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

// スタッフBot用Webhook（postbackでhandoffを切り替える用途）
if (staffLineMiddleware) {
  app.use(
    '/webhook-staff',
    express.raw({ type: 'application/json' }),
    staffLineMiddleware
  );
}

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
  const timer = startTimer();
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'Message is required and must be a non-empty string',
      });
    }

    const response = await generateAnswer(message);
    log.apiCall('openai', 'chat', { duration: timer(), success: true });
    res.json(response);
  } catch (error) {
    log.error('Error in /chat', error);
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

    log.debug('LINE webhook received', { eventCount: events.length });

    // イベント処理（非同期で実行、エラーは内部で処理）
    handleLineWebhook(events).catch((error) => {
      log.error('Unhandled error in webhook handler', error);
    });

    // LINEサーバーには即座に200を返す
    res.status(200).send('OK');
  } catch (error) {
    log.error('Error in /webhook', error);
    // 署名検証エラーなどはミドルウェアが処理済み
    // ここに来る場合は予期しないエラー
    res.status(500).send('Internal server error');
  }
});

/**
 * LINE Webhook（スタッフBot用）
 * - STAFF_LINE_CHANNEL_SECRET を設定した場合のみ有効化
 * - スタッフグループ通知メッセージのpostbackを受け取ってhandoffをON/OFFする
 */
if (staffLineMiddleware) {
  app.post('/webhook-staff', async (req: Request, res: Response) => {
    try {
      const body = req.body as { events?: WebhookEvent[] };
      const events: WebhookEvent[] = body.events || [];

      if (events.length === 0) {
        return res.status(200).send('OK');
      }

      log.debug('Staff webhook received', { eventCount: events.length });

      handleLineWebhook(events, { replyClient: staffWebhookClient }).catch((error) => {
        log.error('Unhandled error in staff webhook handler', error);
      });

      res.status(200).send('OK');
    } catch (error) {
      log.error('Error in /webhook-staff', error);
      res.status(500).send('Internal server error');
    }
  });
}

/**
 * 管理API: インデックス再読み込み
 */
app.post('/admin/reload', async (req: Request, res: Response) => {
  const adminToken = process.env.ADMIN_TOKEN;

  // ADMIN_TOKENが設定されている場合は認証を要求
  if (adminToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      log.warn('Admin reload: Authorization required');
      return res.status(401).json({ error: 'Authorization required' });
    }

    const token = authHeader.substring(7);
    if (token !== adminToken) {
      log.warn('Admin reload: Invalid token');
      return res.status(403).json({ error: 'Invalid token' });
    }
  }

  try {
    const timer = startTimer();
    const index = reloadIndex();
    log.server('reload', { count: index.count, duration: timer() });
    res.json({
      success: true,
      message: 'Index reloaded',
      count: index.count,
      generatedAt: index.generatedAt,
    });
  } catch (error) {
    log.error('Error reloading index', error);
    const message = error instanceof Error ? error.message : 'Failed to reload index';
    res.status(500).json({ error: message });
  }
});

/**
 * エラーハンドリング
 */
app.use((err: Error, req: Request, res: Response, next: express.NextFunction) => {
  log.error('Unhandled error', err, { path: req.path, method: req.method });
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * グレースフルシャットダウン
 */
function gracefulShutdown(signal: string) {
  log.server('stop', { signal });
  server.close(() => {
    log.info('Server closed');
    process.exit(0);
  });

  // 10秒後に強制終了
  setTimeout(() => {
    log.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * サーバー起動
 */
const server = app.listen(PORT, () => {
  log.server('start', { port: PORT });

  // 起動時にインデックスの存在をチェック
  if (indexExists()) {
    log.info('Q&A index found');
  } else {
    log.warn('Q&A index not found. Please run "npm run sync" first.');
  }
});

// ポート競合エラーを処理
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use`, err);
    process.exit(1);
  } else {
    log.error('Server error', err);
    process.exit(1);
  }
});

import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info');

/**
 * 構造化ログシステム
 * - 本番環境: JSON形式で出力
 * - 開発環境: 人間が読みやすい形式で出力
 */
export const logger = pino({
  level: logLevel,
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ロガーのラッパー関数（型安全性向上、console.log互換）
export const log = {
  /**
   * デバッグ情報（console.log互換）
   */
  debug: (message: string, ...args: unknown[]) => {
    if (args.length === 0) {
      logger.debug(message);
    } else if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      logger.debug(args[0] as Record<string, unknown>, message);
    } else {
      logger.debug({ args }, message);
    }
  },

  /**
   * 通常の情報
   */
  info: (message: string, data?: Record<string, unknown>) => {
    logger.info(data, message);
  },

  /**
   * 警告（console.warn互換）
   */
  warn: (message: string, ...args: unknown[]) => {
    if (args.length === 0) {
      logger.warn(message);
    } else if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
      logger.warn(args[0] as Record<string, unknown>, message);
    } else {
      const errorArg = args.find(a => a instanceof Error);
      if (errorArg instanceof Error) {
        logger.warn({ err: errorArg }, message);
      } else {
        logger.warn({ details: args }, message);
      }
    }
  },

  /**
   * エラー（console.error互換）
   */
  error: (message: string, ...args: unknown[]) => {
    if (args.length === 0) {
      logger.error(message);
    } else {
      const errorArg = args.find(a => a instanceof Error);
      const dataArg = args.find(a => typeof a === 'object' && a !== null && !(a instanceof Error)) as Record<string, unknown> | undefined;

      if (errorArg instanceof Error) {
        logger.error({ ...dataArg, err: errorArg }, message);
      } else if (dataArg) {
        logger.error(dataArg, message);
      } else {
        logger.error({ details: args }, message);
      }
    }
  },

  /**
   * LINE Webhookイベント
   */
  lineEvent: (
    eventType: string,
    data: {
      userId?: string;
      groupId?: string;
      messageType?: string;
      [key: string]: unknown;
    }
  ) => {
    logger.info({ event: 'LINE_EVENT', eventType, ...data }, `LINE ${eventType} event received`);
  },

  /**
   * API呼び出し
   */
  apiCall: (
    api: 'openai' | 'line',
    operation: string,
    data?: {
      duration?: number;
      success?: boolean;
      [key: string]: unknown;
    }
  ) => {
    logger.info({ event: 'API_CALL', api, operation, ...data }, `${api} API: ${operation}`);
  },

  /**
   * handoff状態変更
   */
  handoffChange: (data: {
    userId: string;
    enabled: boolean;
    reason?: string;
    updatedBy?: string;
  }) => {
    logger.info(
      { event: 'HANDOFF_CHANGE', ...data },
      `Handoff ${data.enabled ? 'enabled' : 'disabled'} for user`
    );
  },

  /**
   * サーバーイベント
   */
  server: (
    eventType: 'start' | 'stop' | 'error' | 'reload',
    data?: Record<string, unknown>
  ) => {
    logger.info({ event: 'SERVER', eventType, ...data }, `Server ${eventType}`);
  },

  /**
   * パフォーマンス計測
   */
  performance: (operation: string, durationMs: number, data?: Record<string, unknown>) => {
    logger.info(
      { event: 'PERFORMANCE', operation, durationMs, ...data },
      `${operation} completed in ${durationMs}ms`
    );
  },
};

/**
 * パフォーマンス計測用のタイマー
 */
export function startTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}

/**
 * 子ロガーを作成（特定のコンテキスト用）
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

export default logger;

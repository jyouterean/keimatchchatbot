import { log } from './logger';

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: (error: unknown) => boolean;
}

const defaultOptions: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * 指数バックオフ付きリトライ機構
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: unknown;
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // リトライ可能なエラーかチェック
      if (opts.retryableErrors && !opts.retryableErrors(error)) {
        log.error(`${operationName} failed with non-retryable error`, error);
        throw error;
      }

      // 最後の試行だった場合はエラーを投げる
      if (attempt > opts.maxRetries) {
        log.error(`${operationName} failed after ${opts.maxRetries} retries`, error);
        throw error;
      }

      log.warn(`${operationName} failed (attempt ${attempt}/${opts.maxRetries + 1}), retrying in ${delay}ms`, {
        attempt,
        delay,
        error: error instanceof Error ? error.message : String(error),
      });

      // 待機
      await sleep(delay);

      // 次のディレイを計算（指数バックオフ）
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  // ここには到達しないはずだが、TypeScriptの型チェックのため
  throw lastError;
}

/**
 * OpenAI API用のリトライ判定
 */
export function isRetryableOpenAIError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // レート制限エラー
    if (message.includes('rate limit') || message.includes('429')) {
      return true;
    }

    // サーバーエラー
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
      return true;
    }

    // タイムアウト
    if (message.includes('timeout') || message.includes('timed out')) {
      return true;
    }

    // 接続エラー
    if (message.includes('econnreset') || message.includes('econnrefused') || message.includes('network')) {
      return true;
    }
  }

  return false;
}

/**
 * LINE API用のリトライ判定
 */
export function isRetryableLINEError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // サーバーエラー
    if (message.includes('500') || message.includes('502') || message.includes('503')) {
      return true;
    }

    // タイムアウト
    if (message.includes('timeout')) {
      return true;
    }

    // 接続エラー
    if (message.includes('econnreset') || message.includes('network')) {
      return true;
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenAI API呼び出し用のリトライラッパー
 */
export async function withOpenAIRetry<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  return withRetry(operation, operationName, {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryableErrors: isRetryableOpenAIError,
  });
}

/**
 * LINE API呼び出し用のリトライラッパー
 */
export async function withLINERetry<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  return withRetry(operation, operationName, {
    maxRetries: 2,
    initialDelayMs: 500,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
    retryableErrors: isRetryableLINEError,
  });
}

/**
 * アプリケーション設定の一元管理
 * 環境変数から設定を読み込み、デフォルト値を提供する
 */

export interface Config {
  // サーバー設定
  server: {
    port: number;
    nodeEnv: string;
  };

  // OpenAI設定
  openai: {
    embeddingModel: string;
    chatModel: string;
    maxTokens: number;
  };

  // LINE設定
  line: {
    channelSecret: string;
    channelAccessToken: string;
    staffChannelSecret?: string;
    staffChannelAccessToken?: string;
    staffTargetId?: string;
  };

  // 類似度検索設定
  similarity: {
    threshold: number;
    directModeThreshold: number;
    scoreGapThreshold: number;
    ragTopK: number;
  };

  // デバウンス設定
  debounce: {
    delayMs: number;
    maxMessages: number;
    maxChars: number;
  };

  // TTL設定（ミリ秒）
  ttl: {
    messageHistoryMs: number;
    messageHistoryMaxItems: number;
    bugReportMs: number;
    replyModeMs: number;
  };

  // ログ設定
  logging: {
    level: string;
  };

  // 管理設定
  admin: {
    token?: string;
  };
}

let cachedConfig: Config | null = null;

/**
 * 設定を読み込む（シングルトン）
 */
export function getConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = {
    server: {
      port: parseInt(process.env.PORT || '3000', 10),
      nodeEnv: process.env.NODE_ENV || 'development',
    },

    openai: {
      embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      chatModel: process.env.CHAT_MODEL || 'gpt-4o-mini',
      maxTokens: parseInt(process.env.MAX_TOKENS || '2000', 10),
    },

    line: {
      channelSecret: process.env.LINE_CHANNEL_SECRET || '',
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
      staffChannelSecret: process.env.STAFF_LINE_CHANNEL_SECRET,
      staffChannelAccessToken: process.env.STAFF_LINE_CHANNEL_ACCESS_TOKEN,
      staffTargetId: process.env.STAFF_TARGET_ID,
    },

    similarity: {
      threshold: parseFloat(process.env.SIM_THRESHOLD || '0.70'),
      directModeThreshold: parseFloat(process.env.DIRECT_MODE_THRESHOLD || '0.85'),
      scoreGapThreshold: parseFloat(process.env.SCORE_GAP_THRESHOLD || '0.05'),
      ragTopK: parseInt(process.env.RAG_TOP_K || '5', 10),
    },

    debounce: {
      delayMs: parseInt(process.env.DEBOUNCE_MS || '500', 10),
      maxMessages: parseInt(process.env.MAX_DEBOUNCE_MESSAGES || '5', 10),
      maxChars: parseInt(process.env.MAX_DEBOUNCE_CHARS || '800', 10),
    },

    ttl: {
      messageHistoryMs: parseInt(process.env.MESSAGE_HISTORY_TTL_MS || '1800000', 10), // 30分
      messageHistoryMaxItems: parseInt(process.env.MESSAGE_HISTORY_MAX_ITEMS || '10', 10),
      bugReportMs: parseInt(process.env.BUG_REPORT_TTL_MS || '600000', 10), // 10分
      replyModeMs: parseInt(process.env.REPLY_MODE_TIMEOUT_MS || '180000', 10), // 3分
    },

    logging: {
      level: process.env.LOG_LEVEL || 'info',
    },

    admin: {
      token: process.env.ADMIN_TOKEN,
    },
  };

  return cachedConfig;
}

/**
 * 設定キャッシュをクリア（テスト用）
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * 必須設定が存在するかチェック
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const config = getConfig();
  const errors: string[] = [];

  if (!config.line.channelSecret) {
    errors.push('LINE_CHANNEL_SECRET is required');
  }

  if (!config.line.channelAccessToken) {
    errors.push('LINE_CHANNEL_ACCESS_TOKEN is required');
  }

  // OpenAI APIキーは環境変数から直接チェック（セキュリティのためconfigに含めない）
  if (!process.env.OPENAI_API_KEY) {
    errors.push('OPENAI_API_KEY is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 設定のサマリーを取得（機密情報はマスク）
 */
export function getConfigSummary(): Record<string, unknown> {
  const config = getConfig();

  return {
    server: config.server,
    openai: {
      embeddingModel: config.openai.embeddingModel,
      chatModel: config.openai.chatModel,
      maxTokens: config.openai.maxTokens,
    },
    line: {
      hasChannelSecret: !!config.line.channelSecret,
      hasChannelAccessToken: !!config.line.channelAccessToken,
      hasStaffConfig: !!(config.line.staffChannelSecret && config.line.staffTargetId),
    },
    similarity: config.similarity,
    debounce: config.debounce,
    ttl: config.ttl,
    logging: config.logging,
    admin: {
      hasToken: !!config.admin.token,
    },
  };
}

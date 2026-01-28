import { WebhookEvent, MessageEvent, PostbackEvent } from '@line/bot-sdk';

/**
 * LINE Webhookイベントの型定義
 */

// テキストメッセージイベント（簡易版）
export interface SimpleTextMessageEvent {
  type: 'message';
  message: {
    type: 'text';
    text: string;
    id: string;
  };
  replyToken: string;
  source: {
    type: 'user' | 'group' | 'room';
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  timestamp: number;
}

// Postbackイベント（スタッフグループ用）
export interface SimplePostbackEvent {
  type: 'postback';
  replyToken: string;
  postback: {
    data: string;
    params?: Record<string, string>;
  };
  source: {
    type: 'user' | 'group' | 'room';
    userId?: string;
    groupId?: string;
  };
  timestamp: number;
}

/**
 * 型ガード関数
 */

// テキストメッセージイベントかどうか
export function isTextMessageEvent(event: WebhookEvent): boolean {
  return (
    event.type === 'message' &&
    'message' in event &&
    (event as MessageEvent).message.type === 'text'
  );
}

// Postbackイベントかどうか
export function isPostbackEvent(event: WebhookEvent): event is PostbackEvent {
  return event.type === 'postback';
}

// スタッフグループからのPostbackかどうか
export function isStaffGroupPostback(
  event: WebhookEvent,
  staffTargetId: string | undefined
): boolean {
  if (!staffTargetId) return false;
  if (event.type !== 'postback') return false;

  const source = (event as PostbackEvent).source;
  return source?.type === 'group' && 'groupId' in source && (source as { groupId?: string }).groupId === staffTargetId;
}

// ハンドオフ関連のPostbackかどうか
export function isHandoffPostback(data: string): boolean {
  return data.startsWith('handoff:on:') || data.startsWith('handoff:off:');
}

// 返信モードのPostbackかどうか
export function isReplyModePostback(data: string): boolean {
  return data.startsWith('reply:');
}

// グループからのメッセージかどうか
export function isGroupMessage(event: WebhookEvent): boolean {
  const source = (event as MessageEvent).source;
  return source?.type === 'group';
}

// ユーザーIDを安全に取得
export function getUserId(event: WebhookEvent): string | undefined {
  const source = (event as MessageEvent | PostbackEvent).source;
  return source?.userId;
}

// グループIDを安全に取得
export function getGroupId(event: WebhookEvent): string | undefined {
  const source = (event as MessageEvent | PostbackEvent).source;
  if (source?.type === 'group' && 'groupId' in source) {
    return (source as { groupId: string }).groupId;
  }
  return undefined;
}

/**
 * Postbackデータのパース
 */

export interface HandoffPostbackData {
  action: 'on' | 'off';
  userId: string;
}

export interface ReplyModePostbackData {
  targetUserId: string;
  targetDisplayName: string;
}

export function parseHandoffPostback(data: string): HandoffPostbackData | null {
  if (!isHandoffPostback(data)) return null;

  const parts = data.split(':');
  if (parts.length < 3) return null;

  const action = parts[1] as 'on' | 'off';
  const userId = parts.slice(2).join(':');

  return { action, userId };
}

export function parseReplyModePostback(data: string): ReplyModePostbackData | null {
  if (!isReplyModePostback(data)) return null;

  const parts = data.split(':');
  if (parts.length < 2) return null;

  const targetUserId = parts[1];
  const targetDisplayName = parts.slice(2).join(':') || '不明なユーザー';

  return { targetUserId, targetDisplayName };
}

/**
 * 設定値の型
 */
export interface AppConfig {
  // デバウンス設定
  debounceMs: number;
  maxDebounceMessages: number;
  maxDebounceChars: number;

  // TTL設定
  messageHistoryTtlMs: number;
  messageHistoryMaxItems: number;
  bugReportTtlMs: number;
  replyModeTimeoutMs: number;

  // 類似度閾値
  simThreshold: number;
  ragTopK: number;

  // その他
  maxTokens: number;
  port: number;
  logLevel: string;
}

export function loadConfig(): AppConfig {
  return {
    debounceMs: parseInt(process.env.DEBOUNCE_MS || '500', 10),
    maxDebounceMessages: parseInt(process.env.MAX_DEBOUNCE_MESSAGES || '5', 10),
    maxDebounceChars: parseInt(process.env.MAX_DEBOUNCE_CHARS || '800', 10),
    messageHistoryTtlMs: parseInt(process.env.MESSAGE_HISTORY_TTL_MS || '1800000', 10), // 30分
    messageHistoryMaxItems: parseInt(process.env.MESSAGE_HISTORY_MAX_ITEMS || '10', 10),
    bugReportTtlMs: parseInt(process.env.BUG_REPORT_TTL_MS || '600000', 10), // 10分
    replyModeTimeoutMs: parseInt(process.env.REPLY_MODE_TIMEOUT_MS || '180000', 10), // 3分
    simThreshold: parseFloat(process.env.SIM_THRESHOLD || '0.85'),
    ragTopK: parseInt(process.env.RAG_TOP_K || '5', 10),
    maxTokens: parseInt(process.env.MAX_TOKENS || '2000', 10),
    port: parseInt(process.env.PORT || '3000', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

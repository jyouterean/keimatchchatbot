import { Client, middleware, WebhookEvent, TextMessage } from '@line/bot-sdk';
import { generateAnswer } from './qaAnswer';
import { getDisplayName, getHandoffRecord, isHandoffEnabled, listHandoffEnabledUsers, setHandoffEnabled } from './handoffStore';

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!channelAccessToken) {
  throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');
}

export const lineClient = new Client({
  channelAccessToken,
});

/**
 * 担当者通知用の別公式LINEアカウント（任意設定）
 *
 * STAFF_LINE_CHANNEL_ACCESS_TOKEN: 担当者用公式LINEチャネルのアクセストークン
 * STAFF_TARGET_ID: 通知を送りたいトークのID（ユーザーID / グループID / ルームID）
 */
const staffChannelAccessToken = process.env.STAFF_LINE_CHANNEL_ACCESS_TOKEN;
const staffTargetId = process.env.STAFF_TARGET_ID;

// スタッフBot（別チャネル）のWebhook応答に使うクライアント（tokenがあれば作成）
export const staffWebhookClient = staffChannelAccessToken
  ? new Client({ channelAccessToken: staffChannelAccessToken })
  : null;

// スタッフBotのWebhook（ボタンのpostbackを受け取るため）
const staffChannelSecret = process.env.STAFF_LINE_CHANNEL_SECRET;
export const staffLineMiddleware = staffChannelSecret
  ? middleware({ channelSecret: staffChannelSecret })
  : null;

const channelSecret = process.env.LINE_CHANNEL_SECRET;
if (!channelSecret) {
  throw new Error('LINE_CHANNEL_SECRET is not set');
}

export const lineMiddleware = middleware({
  channelSecret,
});

/**
 * ユーザーごとのメッセージ履歴を保存（メモリ上）
 * キー: userId, 値: メッセージ履歴の配列（最新が最後）
 */
const messageHistory = new Map<string, string[]>();

/**
 * 連投対策（デバウンス）
 * - ユーザーごとに一定時間入力を溜めて、最後に1回だけ回答生成する
 */
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '500', 10);
const MAX_DEBOUNCE_MESSAGES = parseInt(process.env.MAX_DEBOUNCE_MESSAGES || '5', 10);
const MAX_DEBOUNCE_CHARS = parseInt(process.env.MAX_DEBOUNCE_CHARS || '800', 10);

type PendingDebounce = {
  timer: NodeJS.Timeout;
  messages: string[];
  replyToken: string;
  lastAt: number;
};

const pendingDebounce = new Map<string, PendingDebounce>();
const inFlightUsers = new Set<string>();

function isReleaseCommand(text: string): boolean {
  const t = text.trim();
  return (
    t === '解除' ||
    t === '担当者解除' ||
    t === '担当者終了' ||
    t === '再開' ||
    t === 'bot再開' ||
    t === 'Bot再開' ||
    t === 'BOT再開'
  );
}

function buildHandoffFlex(params: {
  userId: string;
  displayName: string;
  currentText: string;
  previousText?: string;
}): any {
  const record = getHandoffRecord(params.userId);
  const status = record?.enabled ? 'ON（Bot停止中）' : 'OFF（Bot稼働）';

  return {
    type: 'flex',
    altText: `担当者対応: ${params.displayName}（${status}）`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '担当者対応', weight: 'bold', size: 'lg' },
          { type: 'text', text: `状態: ${status}`, size: 'sm', color: '#666666' },
          { type: 'text', text: `ユーザー: ${params.displayName}`, size: 'sm', wrap: true },
        ],
        paddingAll: '12px',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          ...(params.previousText
            ? [
                { type: 'text', text: '一つ前', size: 'sm', color: '#666666' },
                { type: 'text', text: params.previousText, wrap: true, size: 'sm' },
              ]
            : []),
          { type: 'text', text: '今回', size: 'sm', color: '#666666' },
          { type: 'text', text: params.currentText, wrap: true, size: 'md' },
        ],
        paddingAll: '12px',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#D0021B',
            action: {
              type: 'postback',
              label: 'Bot停止（このユーザー）',
              data: `handoff:on:${params.userId}`,
              displayText: 'Bot停止（このユーザー）',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: 'Bot再開（このユーザー）',
              data: `handoff:off:${params.userId}`,
              displayText: 'Bot再開（このユーザー）',
            },
          },
        ],
        paddingAll: '12px',
      },
    },
  };
}

function buildHandoffListBubble(params: { userId: string; displayName: string }): any {
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: params.displayName, weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: '状態: ON（Bot停止中）', size: 'sm', color: '#D0021B' },
      ],
      paddingAll: '10px',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          action: {
            type: 'postback',
            label: 'Bot再開（OFF）',
            data: `handoff:off:${params.userId}`,
            displayText: `Bot再開（${params.displayName}）`,
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: 'Bot停止（ON）',
            data: `handoff:on:${params.userId}`,
            displayText: `Bot停止（${params.displayName}）`,
          },
        },
      ],
      paddingAll: '10px',
    },
  };
}

function isHandoffListCommand(text: string): boolean {
  const t = text.trim();
  return (
    t === '停止中一覧' ||
    t === '担当者一覧' ||
    t === 'handoff一覧' ||
    t === 'Handoff一覧' ||
    t === 'BOT停止中一覧' ||
    t === 'bot停止中一覧'
  );
}

async function sendReplyWithSplit(params: {
  replyClient: Client;
  userId: string;
  replyToken: string;
  replyText: string;
}) {
  const LINE_MAX_LENGTH = 5000;
  const messages = splitLongMessage(params.replyText, LINE_MAX_LENGTH);

  if (messages.length === 1) {
    await params.replyClient.replyMessage(params.replyToken, {
      type: 'text',
      text: messages[0],
    });
    return;
  }

  // 最初はreplyMessage、残りはpushMessage（userIdが必要）
  await params.replyClient.replyMessage(params.replyToken, {
    type: 'text',
    text: messages[0] + `\n\n（続き ${messages.length - 1}件）`,
  });

  for (let i = 1; i < messages.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await params.replyClient.pushMessage(params.userId, {
      type: 'text',
      text: messages[i] + (i < messages.length - 1 ? `\n\n（続き ${messages.length - i - 1}件）` : ''),
    });
  }
}

function trimDebounceBuffer(messages: string[]): string[] {
  let trimmed = [...messages];

  // 件数制限（古い方から落とす）
  while (trimmed.length > MAX_DEBOUNCE_MESSAGES) {
    trimmed.shift();
  }

  // 文字数制限（古い方から落とす）
  while (trimmed.join('\n').length > MAX_DEBOUNCE_CHARS && trimmed.length > 1) {
    trimmed.shift();
  }

  // それでも長い場合は末尾を切る（最後の1件が極端に長いケース）
  const joined = trimmed.join('\n');
  if (joined.length > MAX_DEBOUNCE_CHARS) {
    trimmed = [joined.slice(0, MAX_DEBOUNCE_CHARS)];
  }

  return trimmed;
}

async function flushDebounce(userId: string) {
  const pending = pendingDebounce.get(userId);
  if (!pending) return;

  // 多重flush防止
  if (inFlightUsers.has(userId)) return;
  inFlightUsers.add(userId);

  // 先に削除（flush中に新規メッセージが来た場合は新しいpendingが作られる）
  pendingDebounce.delete(userId);

  try {
    const messages = trimDebounceBuffer(pending.messages);
    const combined = messages.join('\n').trim();
    if (!combined) return;

    const history = messageHistory.get(userId) || [];
    const conversationHistory = history.slice(-3);

    const response = await generateAnswer(combined, conversationHistory);
    const replyText = response.answer;

    // replyToken失効等に備えて、reply→失敗したらpushにフォールバック
    try {
      await sendReplyWithSplit({
        replyClient: lineClient,
        userId,
        replyToken: pending.replyToken,
        replyText,
      });
    } catch (err) {
      console.warn('replyMessage failed, fallback to pushMessage:', err);
      await lineClient.pushMessage(userId, { type: 'text', text: replyText });
    }

    // 履歴はflush時に「結合した1件」として保存（連投を1ターン扱い）
    const nextHistory = [...history, combined];
    while (nextHistory.length > 10) nextHistory.shift();
    messageHistory.set(userId, nextHistory);
  } catch (error) {
    console.error('Error in debounce flush:', error);
  } finally {
    inFlightUsers.delete(userId);
  }
}

function enqueueDebounce(params: { userId: string; replyToken: string; text: string }) {
  const existing = pendingDebounce.get(params.userId);
  const now = Date.now();

  if (existing) {
    existing.messages.push(params.text);
    existing.messages = trimDebounceBuffer(existing.messages);
    existing.replyToken = params.replyToken; // 常に最新を使う
    existing.lastAt = now;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      flushDebounce(params.userId).catch((e) => console.error('flushDebounce failed:', e));
    }, DEBOUNCE_MS);
    return;
  }

  const timer = setTimeout(() => {
    flushDebounce(params.userId).catch((e) => console.error('flushDebounce failed:', e));
  }, DEBOUNCE_MS);

  pendingDebounce.set(params.userId, {
    timer,
    messages: trimDebounceBuffer([params.text]),
    replyToken: params.replyToken,
    lastAt: now,
  });
}

/**
 * 担当者用トークに通知を送信
 */
async function notifyStaff(event: WebhookEvent & { message: TextMessage }, previousMessage?: string) {
  if (!staffWebhookClient || !staffTargetId) {
    console.warn('Staff notification is not configured (STAFF_LINE_CHANNEL_ACCESS_TOKEN / STAFF_TARGET_ID).');
    return;
  }

  const source = (event as any).source || {};
  const userId = source.userId;

  // ユーザーIDからLINEネーム（表示名）を取得
  let displayName = '不明なユーザー';
  if (userId) {
    try {
      const profile = await lineClient.getProfile(userId);
      displayName = profile.displayName || userId;
    } catch (error) {
      // プロフィール取得に失敗した場合（友だち削除済みなど）はユーザーIDを表示
      console.warn(`Failed to get profile for userId ${userId}:`, error);
      displayName = userId;
    }
  }

  const text = event.message.text || '';

  // ボタン付き通知（postbackでON/OFFを切り替える）
  if (userId) {
    // 表示名も保存（スタッフ側でIDを表示しないため）
    setHandoffEnabled({
      userId,
      enabled: true,
      updatedBy: userId,
      reason: 'user_requested_staff',
      displayName,
    });

    const flex = buildHandoffFlex({
      userId,
      displayName,
      currentText: text,
      previousText: previousMessage,
    });
    await staffWebhookClient.pushMessage(staffTargetId, flex);
    return;
  }

  // userIdが取得できない場合はテキスト通知のみ
  await staffWebhookClient.pushMessage(staffTargetId, {
    type: 'text',
    text: `対応が必要なメッセージが届きました。\n\n送信ユーザー: ${displayName}\n\n今回のメッセージ:\n${text}`,
  });
}

/**
 * 長文メッセージを複数のメッセージに分割
 */
function splitLongMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const messages: string[] = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    const remaining = text.length - currentIndex;
    
    if (remaining <= maxLength) {
      // 残りがmaxLength以下なら、そのまま追加
      messages.push(text.substring(currentIndex));
      break;
    }

    // maxLengthまで切り取り、改行や句点で区切れる位置を探す
    let cutIndex = currentIndex + maxLength;
    
    // 改行で区切れる位置を探す（後ろに最大200文字まで戻る）
    const searchStart = Math.max(currentIndex, cutIndex - 200);
    const lastNewline = text.lastIndexOf('\n', cutIndex);
    const lastPeriod = text.lastIndexOf('。', cutIndex);
    const lastQuestion = text.lastIndexOf('？', cutIndex);
    const lastExclamation = text.lastIndexOf('！', cutIndex);
    
    // 最も近い区切り文字を見つける
    const bestCut = Math.max(
      lastNewline,
      lastPeriod,
      lastQuestion,
      lastExclamation
    );

    if (bestCut > searchStart) {
      cutIndex = bestCut + 1; // 区切り文字の後から
    }

    messages.push(text.substring(currentIndex, cutIndex));
    currentIndex = cutIndex;
  }

  return messages;
}

/**
 * LINE Webhookイベントを処理
 */
export async function handleLineWebhook(
  events: WebhookEvent[],
  opts?: { replyClient?: Client | null }
): Promise<void> {
  // postback返信に使うクライアント（デフォルトはメインBot）
  const replyClient = opts?.replyClient ?? lineClient;
  for (const event of events) {
    // スタッフグループのpostbackでhandoffを切り替え
    if (event.type === 'postback') {
      const source: any = (event as any).source || {};
      const groupId: string | undefined = source.groupId;
      const data: string = (event as any).postback?.data || '';

      // 通知先グループからのpostbackだけを受理
      if (staffTargetId && groupId && groupId === staffTargetId && (data.startsWith('handoff:on:') || data.startsWith('handoff:off:'))) {
        const parts = data.split(':');
        const action = parts[1]; // on/off
        const userId = parts.slice(2).join(':');
        if (userId) {
          const enabled = action === 'on';
          setHandoffEnabled({
            userId,
            enabled,
            updatedBy: groupId,
            reason: 'staff_group_postback',
          });

          // グループに結果を返信（このイベントが発生したBotのチャネルで返信）
          if (replyClient) {
            try {
              const name = getDisplayName(userId) || '不明なユーザー';
              await replyClient.replyMessage((event as any).replyToken, {
                type: 'text',
                text: `handoffを更新しました: ${enabled ? 'ON（Bot停止）' : 'OFF（Bot再開）'}\nユーザー: ${name}`,
              });
            } catch (e) {
              console.warn('Failed to reply handoff update to group:', e);
            }
          }
        }
      }
      continue;
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
      continue;
    }

    // スタッフグループでの「一覧」コマンド（スタッフBot webhookで受ける想定）
    {
      const sourceAny: any = (event as any).source || {};
      const groupId: string | undefined = sourceAny.groupId;
      const incomingText = String((event as any).message?.text || '').trim();

      if (staffTargetId && groupId && groupId === staffTargetId && isHandoffListCommand(incomingText)) {
        if (!replyClient) continue;

        const enabledUsers = listHandoffEnabledUsers();
        if (enabledUsers.length === 0) {
          try {
            await replyClient.replyMessage((event as any).replyToken, {
              type: 'text',
              text: '現在、Bot停止中（担当者対応中）のユーザーはいません。',
            });
          } catch (e) {
            console.warn('Failed to reply empty handoff list:', e);
          }
          continue;
        }

        // Flexカルーセルは最大10バブル/メッセージが安全圏
        const chunks: typeof enabledUsers[] = [];
        for (let i = 0; i < enabledUsers.length; i += 10) {
          chunks.push(enabledUsers.slice(i, i + 10));
        }

        const messages = chunks.map((chunk, idx) => {
          const bubbles = chunk.map(({ userId, record }) =>
            buildHandoffListBubble({
              userId,
              displayName: record.displayName || '不明なユーザー',
            })
          );
          return {
            type: 'flex',
            altText: `停止中ユーザー一覧（${enabledUsers.length}件）${chunks.length > 1 ? ` ${idx + 1}/${chunks.length}` : ''}`,
            contents: { type: 'carousel', contents: bubbles },
          };
        });

        try {
          // replyMessageは最大5メッセージなので5チャンクまで
          const max = Math.min(messages.length, 5);
          await replyClient.replyMessage((event as any).replyToken, messages.slice(0, max) as any);
          if (messages.length > 5) {
            await replyClient.pushMessage(staffTargetId, {
              type: 'text',
              text: `停止中ユーザーが多いため一部のみ表示しました（最大50件）。必要なら「停止中一覧」をもう一度送ってください。`,
            } as any);
          }
        } catch (e) {
          console.warn('Failed to reply handoff list:', e);
        }
        continue;
      }
    }

    const textEvent = event as WebhookEvent & {
      message: TextMessage;
      replyToken: string;
      source: { userId?: string };
    };

    // source情報をログに出力して、groupId / roomId / userId を確認できるようにする
    console.log('LINE source:', JSON.stringify(textEvent.source, null, 2));

    const incomingText = (textEvent.message.text || '').trim();
    const userId = textEvent.source?.userId;

    try {
      // 「担当者」が送られてきた場合の特別対応
      if (incomingText === '担当者') {
        // ユーザーへの返信
        await lineClient.replyMessage(textEvent.replyToken, {
          type: 'text',
          text: '担当者が返信しますのでしばらくお待ちください。',
        });

        // 一つ前のメッセージを取得（ユーザーが送ったメッセージのみ）
        let previousMessage: string | undefined;
        if (userId) {
          const history = messageHistory.get(userId) || [];
          // 履歴から一つ前のメッセージを取得（最新が最後にある）
          if (history.length > 0) {
            previousMessage = history[history.length - 1];
          }
        }

        // 担当者用トークへ通知（設定されている場合のみ）
        await notifyStaff(textEvent, previousMessage);
        continue;
      }

      // handoff中はBotが返信しない（解除コマンドのみ受け付け）
      if (userId && isHandoffEnabled(userId)) {
        if (isReleaseCommand(incomingText)) {
          setHandoffEnabled({
            userId,
            enabled: false,
            updatedBy: userId,
            reason: 'user_released',
            displayName: undefined,
          });
          await lineClient.replyMessage(textEvent.replyToken, {
            type: 'text',
            text: '担当者対応を終了しました。Botの自動回答を再開します。',
          });
        }
        // 解除以外はBot返信しない
        continue;
      }

      // 連投対策（デバウンス）
      // userIdが取れる（1:1想定）場合のみ、一定時間まとめてから1回だけ回答する。
      // userIdが取れない場合（グループ等）は従来どおり即時回答。
      if (userId) {
        enqueueDebounce({
          userId,
          replyToken: textEvent.replyToken,
          text: incomingText,
        });
        continue;
      }

      // userIdが取れない場合は従来どおり即時回答
      const response = await generateAnswer(incomingText, undefined);
      await sendReplyWithSplit({
        replyClient: lineClient,
        userId: 'unknown',
        replyToken: textEvent.replyToken,
        replyText: response.answer,
      });
    } catch (error) {
      console.error('Error handling LINE message:', error);
      
      // エラーメッセージを返信
      const errorMessage = error instanceof Error 
        ? error.message 
        : 'エラーが発生しました。しばらくしてから再度お試しください。';
      
      try {
        await lineClient.replyMessage(textEvent.replyToken, {
          type: 'text',
          text: `申し訳ございません。${errorMessage}`,
        });
      } catch (replyError) {
        console.error('Failed to send error reply:', replyError);
      }
    }
  }
}


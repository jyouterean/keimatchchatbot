import { Client, middleware, WebhookEvent, TextMessage } from '@line/bot-sdk';
import { generateAnswer } from './qaAnswer';
import { getHandoffRecord, isHandoffEnabled, setHandoffEnabled } from './handoffStore';

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
          { type: 'text', text: `userId: ${params.userId}`, size: 'xs', color: '#999999', wrap: true },
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
              await replyClient.replyMessage((event as any).replyToken, {
                type: 'text',
                text: `handoffを更新しました: ${enabled ? 'ON（Bot停止）' : 'OFF（Bot再開）'}\nuserId: ${userId}`,
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
        if (userId) {
          setHandoffEnabled({
            userId,
            enabled: true,
            updatedBy: userId,
            reason: 'user_requested_staff',
          });
        }

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
          });
          await lineClient.replyMessage(textEvent.replyToken, {
            type: 'text',
            text: '担当者対応を終了しました。Botの自動回答を再開します。',
          });
        }
        // 解除以外はBot返信しない
        continue;
      }

      // 直近の履歴（最大2件）を取得
      let conversationHistory: string[] | undefined;
      if (userId) {
        const history = messageHistory.get(userId) || [];
        conversationHistory = history.slice(-2); // 2つ前まで
      }

      // 通常のQ&A回答を生成（履歴を別パラメータとして渡す）
      const response = await generateAnswer(incomingText, conversationHistory);

      // 「担当者」以外のメッセージは履歴に保存（ユーザーが送ったメッセージのみ）
      if (userId && incomingText) {
        const history = messageHistory.get(userId) || [];
        history.push(incomingText);
        // 履歴は最新10件まで保持（メモリ節約）
        if (history.length > 10) {
          history.shift();
        }
        messageHistory.set(userId, history);
      }

      // 回答テキスト（※AIが生成した旨の文言は付けない）
      const replyText = response.answer;

      // LINEメッセージの文字数制限（5000文字）に対応
      // 長文の場合は複数のメッセージに分割して送信
      const LINE_MAX_LENGTH = 5000;
      const messages = splitLongMessage(replyText, LINE_MAX_LENGTH);

      if (messages.length === 1) {
        // 1つのメッセージで送信可能な場合
        await lineClient.replyMessage(textEvent.replyToken, {
          type: 'text',
          text: messages[0],
        });
      } else {
        // 複数のメッセージに分割する必要がある場合
        // 最初のメッセージはreplyMessageを使用
        await lineClient.replyMessage(textEvent.replyToken, {
          type: 'text',
          text: messages[0] + `\n\n（続き ${messages.length - 1}件）`,
        });

        // 残りのメッセージはpushMessageを使用（userIdが必要）
        const userId = textEvent.source?.userId;
        if (userId && messages.length > 1) {
          // 少し待ってから残りのメッセージを送信（APIレート制限対策）
          for (let i = 1; i < messages.length; i++) {
            await new Promise(resolve => setTimeout(resolve, 500)); // 500ms待機
            await lineClient.pushMessage(userId, {
              type: 'text',
              text: messages[i] + (i < messages.length - 1 ? `\n\n（続き ${messages.length - i - 1}件）` : ''),
            });
          }
        } else if (messages.length > 1) {
          // userIdが取得できない場合（グループチャット等）、最初のメッセージのみ送信
          console.warn('userId not available, sending only first message');
        }
      }
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


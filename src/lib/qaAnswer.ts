import { openai, CHAT_MODEL, EMBEDDING_MODEL } from './openaiClient';
import { loadIndex, searchTopK } from './indexStore';
import { l2Normalize } from './similarity';
import * as fs from 'fs';
import * as path from 'path';

export interface ChatResponse {
  mode: 'direct' | 'rag';
  answer: string;
  top3: Array<{ score: number; question: string }>;
  match?: {
    score: number;
    question: string;
    meta: {
      category?: string;
      keywords?: string;
    };
  };
}

const SIM_THRESHOLD = parseFloat(process.env.SIM_THRESHOLD || '0.84');

/**
 * 軽マッチの前提情報を読み込む
 */
function loadKeimatchContext(): string {
  try {
    const contextPath = path.join(__dirname, '../../data/keimatch_context.md');
    if (fs.existsSync(contextPath)) {
      return fs.readFileSync(contextPath, 'utf-8');
    }
  } catch (error) {
    console.warn('Failed to load keimatch context:', error);
  }
  return '';
}

/**
 * チャット回答を生成
 * @param message 現在の質問メッセージ
 * @param conversationHistory 会話履歴（オプション、最新が最後）
 */
export async function generateAnswer(
  message: string,
  conversationHistory?: string[]
): Promise<ChatResponse> {
  if (!message || !message.trim()) {
    throw new Error('Message is required');
  }

  // インデックスが存在するかチェック
  try {
    loadIndex();
  } catch (error) {
    throw new Error(
      'Q&A index not found. Please run "npm run sync" first to generate the index.'
    );
  }

  // クエリのEmbeddingを生成（現在の質問のみを使用）
  const queryResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: message.trim(),
  });

  const queryEmbedding = queryResponse.data[0]?.embedding;
  if (!queryEmbedding) {
    throw new Error('Failed to generate query embedding');
  }

  // TopK検索
  const topKResults = searchTopK(queryEmbedding, 3);

  const top3 = topKResults.map((r) => ({
    score: r.score,
    question: r.item.question,
  }));

  const best = topKResults[0];

  // スコアが閾値以上なら直接回答
  if (best && best.score >= SIM_THRESHOLD) {
    return {
      mode: 'direct',
      answer: best.item.answer,
      top3,
      match: {
        score: best.score,
        question: best.item.question,
        meta: best.item.meta,
      },
    };
  }

  // 類似度が閾値未満の場合は、RAGモードでLLM生成
  // 前提情報と類似Q&Aを参考に回答を生成
  const keimatchContext = loadKeimatchContext();
  
  // 類似Q&Aをコンテキストとして準備
  const contextQAs = topKResults
    .map((r, i) => {
      const q = r.item.question;
      const a = r.item.answer;
      return `Q${i + 1}: ${q}\nA${i + 1}: ${a}`;
    })
    .join('\n\n');

  // 会話履歴をコンテキストとして準備
  let historyContext = '';
  if (conversationHistory && conversationHistory.length > 0) {
    // 直近2件までの履歴を含める
    const recentHistory = conversationHistory.slice(-2);
    historyContext = `## 会話履歴\n${recentHistory.map((h, i) => `過去の質問${i + 1}: ${h}`).join('\n')}\n\n`;
  }

  // プロンプトを構築
  let prompt = `あなたは軽マッチのカスタマーサポートアシスタントです。以下の情報を参考に、ユーザーの質問に回答してください。

${keimatchContext ? `## 軽マッチの基本情報\n${keimatchContext}\n\n` : ''}${historyContext}${contextQAs ? `## 参考Q&A\n${contextQAs}\n\n` : ''}ユーザーの質問: ${message}

回答のルール:
- 軽マッチの基本情報と参考Q&Aを基に、正確で分かりやすい回答をしてください
- 会話履歴がある場合は、文脈を考慮して回答してください
- 参考Q&Aに該当する情報があれば、それを基に簡潔に回答してください
- 参考Q&Aに該当する情報が不足している場合は、「その質問に対する明確な答えが見つかりません」と伝え、類似した質問候補を提示してください
- 担当者への問い合わせが必要な場合は、「担当者からの解答が必要な場合、『担当者』と入力してください」と案内してください`;

  // max_tokensを環境変数から取得（デフォルト: 2000）
  const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '2000', 10);

  try {
    const chatResponse = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'あなたは軽マッチのカスタマーサポートアシスタントです。提供された情報のみを根拠として回答してください。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: MAX_TOKENS,
    });

    const answer = chatResponse.choices[0]?.message?.content;
    if (!answer) {
      throw new Error('Failed to generate answer from OpenAI');
    }

    return {
      mode: 'rag',
      answer: answer.trim(),
      top3,
    };
  } catch (error) {
    // LLM生成に失敗した場合は、固定メッセージで案内
    console.error('Error generating RAG answer:', error);
    const suggestionsText =
      top3.length > 0
        ? top3.map((item, i) => `${i + 1}. ${item.question}`).join('\n')
        : '（類似した質問候補は見つかりませんでした）';

    const fallbackAnswer = `その質問に対する明確な答えが見つかりません。

以下の質問内容とは違いますか？

${suggestionsText}

また担当者からの解答が必要な場合、「担当者」と入力してください。`;

    return {
      mode: 'rag',
      answer: fallbackAnswer,
      top3,
    };
  }
}


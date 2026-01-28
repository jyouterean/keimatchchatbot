import { openai, CHAT_MODEL, EMBEDDING_MODEL } from './openaiClient';
import { loadIndex, searchTopK } from './indexStore';
import { l2Normalize } from './similarity';
import { withOpenAIRetry } from './retry';
import { log } from './logger';
import { sanitizeInput, filterLLMOutput, analyzeInputSafety } from './sanitize';
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

// 類似度閾値（直接回答モード用）
const SIM_THRESHOLD = parseFloat(process.env.SIM_THRESHOLD || '0.85');
// RAGモードで使用する検索結果の数
const RAG_TOP_K = parseInt(process.env.RAG_TOP_K || '5', 10);

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
    log.warn('Failed to load keimatch context', error);
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

  // 入力のサニタイズとセキュリティチェック
  const safetyReport = analyzeInputSafety(message);
  const sanitizedMessage = safetyReport.sanitized;

  if (safetyReport.warnings.length > 0) {
    log.warn('Input safety warnings', { warnings: safetyReport.warnings });
  }

  // インデックスが存在するかチェック
  try {
    loadIndex();
  } catch (error) {
    throw new Error(
      'Q&A index not found. Please run "npm run sync" first to generate the index.'
    );
  }

  // クエリのEmbeddingを生成（サニタイズ済みメッセージを使用、リトライ付き）
  const queryResponse = await withOpenAIRetry(
    () => openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: sanitizedMessage,
    }),
    'OpenAI Embeddings'
  );

  const queryEmbedding = queryResponse.data[0]?.embedding;
  if (!queryEmbedding) {
    throw new Error('Failed to generate query embedding');
  }

  // TopK検索（直接回答用とRAG用で異なる数を取得）
  const topKForDirect = searchTopK(queryEmbedding, 1);
  const topKForRAG = searchTopK(queryEmbedding, RAG_TOP_K);

  const top3 = topKForRAG.slice(0, 3).map((r) => ({
    score: r.score,
    question: r.item.question,
  }));

  const best = topKForDirect[0];

  // スコアが閾値以上なら直接回答
  // ただし、2位以下が非常に近いスコアの場合はRAGモードで統合回答を生成
  const secondBest = topKForRAG[1];
  const scoreGap = best ? (best.score - (secondBest?.score || 0)) : 0;
  const useDirectMode = best && best.score >= SIM_THRESHOLD && scoreGap >= 0.05;

  if (useDirectMode) {
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

  // 類似度が閾値未満、または複数の候補が近い場合は、RAGモードでLLM生成
  // 前提情報と類似Q&Aを参考に回答を生成
  const keimatchContext = loadKeimatchContext();
  
  // 類似Q&Aをコンテキストとして準備（スコア付き）
  const contextQAs = topKForRAG
    .filter((r) => r.score > 0.7) // スコアが0.7以上のもののみ使用
    .map((r, i) => {
      const q = r.item.question;
      const a = r.item.answer;
      const score = r.score;
      const category = r.item.meta.category ? ` [カテゴリ: ${r.item.meta.category}]` : '';
      const keywords = r.item.meta.keywords ? ` [キーワード: ${r.item.meta.keywords}]` : '';
      return `【類似度: ${(score * 100).toFixed(1)}%】${category}${keywords}\nQ${i + 1}: ${q}\nA${i + 1}: ${a}`;
    })
    .join('\n\n');

  // 会話履歴をコンテキストとして準備
  let historyContext = '';
  if (conversationHistory && conversationHistory.length > 0) {
    // 直近3件までの履歴を含める（文脈をより多く保持）
    const recentHistory = conversationHistory.slice(-3);
    historyContext = `## 会話履歴（時系列順、最新が最後）\n${recentHistory.map((h, i) => `過去の質問${i + 1}: ${h}`).join('\n')}\n\n`;
  }

  // 最高スコアを取得（プロンプトに含める）
  const bestScore = best ? best.score : 0;
  const scoreInfo = bestScore > 0 ? `\n\n【検索結果の信頼度】\n最も類似した質問との類似度: ${(bestScore * 100).toFixed(1)}%\n` : '';

  // プロンプトを構築（より構造化された形式）
  let prompt = `あなたは軽マッチのカスタマーサポートアシスタントです。以下の情報を参考に、ユーザーの質問に対して正確で分かりやすい回答を生成してください。

${keimatchContext ? `## 軽マッチの基本情報\n${keimatchContext}\n\n` : ''}${historyContext}${contextQAs ? `## 参考Q&A（類似度の高い順）\n${contextQAs}\n${scoreInfo}` : ''}## ユーザーの質問
<user_input>
${sanitizedMessage}
</user_input>

## 回答生成の指示

1. **情報の優先順位**:
   - まず、参考Q&Aの中から最も関連性の高い情報を特定してください
   - 参考Q&Aに該当する情報がある場合は、それを基に回答を構築してください
   - 軽マッチの基本情報を補足として使用してください
- 会話履歴がある場合は、文脈を考慮して回答してください

2. **回答の品質**:
   - 正確で具体的な情報を提供してください
   - 分かりやすく、簡潔に回答してください
   - 数値や料金などの具体的な情報は正確に記載してください
   - 推測や不確実な情報は含めないでください

3. **情報が不足している場合**:
   - 参考Q&Aに該当する情報が不足している場合のみ、「その質問に対する明確な答えが見つかりません」と伝えてください
   - その場合、類似した質問候補を提示してください
   - 必ず最後に「また担当者からの解答が必要な場合、『担当者』と入力してください。」という案内を含めてください

4. **回答形式**:
   - 箇条書きや段落を適切に使用して読みやすくしてください
   - 重要な情報は強調してください（必要に応じて）`;

  // max_tokensを環境変数から取得（デフォルト: 2000）
  const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '2000', 10);

  try {
    const chatResponse = await withOpenAIRetry(
      () => openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'あなたは軽マッチのカスタマーサポートアシスタントです。提供された情報のみを根拠として回答してください。推測や憶測は避け、確実な情報のみを伝えてください。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2, // より一貫性のある回答のため温度を下げる
        max_tokens: MAX_TOKENS,
      }),
      'OpenAI Chat Completion'
    );

    let answer = chatResponse.choices[0]?.message?.content;
    if (!answer) {
      throw new Error('Failed to generate answer from OpenAI');
    }

    // LLM出力のフィルタリング（機密情報漏洩対策）
    answer = filterLLMOutput(answer.trim());

    // 「明確な答えが見つかりません」が含まれている場合、最後に担当者の案内を追加
    if (answer.includes('明確な答えが見つかりません') || answer.includes('答えが見つかりません')) {
      if (!answer.includes('担当者') && !answer.includes('「担当者」')) {
        answer += '\n\nまた担当者からの解答が必要な場合、「担当者」と入力してください。';
      }
    }

    return {
      mode: 'rag',
      answer,
      top3,
    };
  } catch (error) {
    // LLM生成に失敗した場合は、固定メッセージで案内
    log.error('Error generating RAG answer', error);
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


import * as fs from 'fs';
import * as path from 'path';
import { l2Normalize, dotProduct, topK } from './similarity';

export interface QAIndexItem {
  id: string;
  question: string;
  answer: string;
  meta: {
    category?: string;
    keywords?: string;
  };
  emb: number[];
}

export interface QAIndex {
  generatedAt: string;
  embeddingModel: string;
  count: number;
  items: QAIndexItem[];
}

const INDEX_PATH = path.join(process.cwd(), 'data', 'qa_index.json');

let cachedIndex: QAIndex | null = null;

/**
 * インデックスファイルを読み込む
 */
export function loadIndex(): QAIndex {
  if (cachedIndex) {
    return cachedIndex;
  }

  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error(
      `Index file not found: ${INDEX_PATH}\nPlease run 'npm run sync' first to generate the index.`
    );
  }

  try {
    const content = fs.readFileSync(INDEX_PATH, 'utf-8');
    cachedIndex = JSON.parse(content) as QAIndex;
    return cachedIndex;
  } catch (error) {
    throw new Error(`Failed to load index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * インデックスを再読み込み（メモリキャッシュをクリア）
 */
export function reloadIndex(): QAIndex {
  cachedIndex = null;
  return loadIndex();
}

/**
 * クエリベクトルに対してTopK検索を実行
 */
export function searchTopK(
  queryEmbedding: number[],
  k: number = 3
): Array<{ item: QAIndexItem; score: number }> {
  const index = loadIndex();
  const queryNorm = l2Normalize(queryEmbedding);

  const scores = index.items.map(item => {
    const itemNorm = l2Normalize(item.emb);
    return dotProduct(queryNorm, itemNorm);
  });

  const topKResults = topK(index.items, scores, k);

  return topKResults.map(result => ({
    item: result.item,
    score: result.score,
  }));
}

/**
 * インデックスが存在するかチェック
 */
export function indexExists(): boolean {
  return fs.existsSync(INDEX_PATH);
}



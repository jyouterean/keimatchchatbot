import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import dotenv from 'dotenv';
import { parse } from 'papaparse';
import * as XLSX from 'xlsx';
import { openai, EMBEDDING_MODEL } from '../src/lib/openaiClient';
import { normalizeRows } from '../src/lib/normalize';
import { l2Normalize } from '../src/lib/similarity';

// 環境変数を読み込む
dotenv.config();

interface QAIndexItem {
  id: string;
  question: string;
  answer: string;
  meta: {
    category?: string;
    keywords?: string;
  };
  emb: number[];
}

interface QAIndex {
  generatedAt: string;
  embeddingModel: string;
  count: number;
  items: QAIndexItem[];
}

/**
 * FNV-1a ハッシュ関数（簡易版）
 */
function fnv1aHash(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

/**
 * CSV URLからデータを取得（リダイレクト対応）
 */
async function fetchCSV(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    
    const makeRequest = (requestUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const req = client.get(requestUrl, (res) => {
        // リダイレクトを処理（301, 302, 307, 308）
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const location = res.headers.location;
          if (!location) {
            reject(new Error(`HTTP ${res.statusCode}: Redirect location not found`));
            return;
          }
          // 相対URLの場合は絶対URLに変換
          const redirectUrl = location.startsWith('http') ? location : new URL(location, requestUrl).href;
          makeRequest(redirectUrl, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(data);
        });
      });

      req.on('error', (err) => {
        reject(err);
      });
    };

    makeRequest(url);
  });
}

/**
 * CSVをパース
 */
function parseCSV(csvContent: string): Record<string, string | undefined>[] {
  // BOM（Byte Order Mark）を削除
  let content = csvContent;
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  
  const result = parse<Record<string, string | undefined>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => {
      // ヘッダー名の前後の空白やBOMを削除
      return header.trim().replace(/^\uFEFF/, '');
    },
    transform: (value: string) => {
      // 値の前後の空白を削除（ただし空文字列はそのまま）
      return value === '' ? value : value.trim();
    },
  });

  if (result.errors.length > 0) {
    console.warn('CSV parse warnings:', result.errors.slice(0, 10)); // 最初の10件のみ表示
    if (result.errors.length > 10) {
      console.warn(`... and ${result.errors.length - 10} more errors`);
    }
  }

  console.log(`Parsed ${result.data.length} rows from CSV`);
  if (result.data.length > 0) {
    console.log(`Sample columns:`, Object.keys(result.data[0]));
  }

  return result.data;
}

/**
 * Excelファイルを読み込む
 */
function parseExcel(filePath: string): Record<string, string | undefined>[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found: ${filePath}`);
  }

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  const data = XLSX.utils.sheet_to_json<Record<string, string | undefined>>(worksheet, {
    defval: undefined,
  });

  return data;
}

/**
 * Embeddingを生成（逐次処理）
 */
async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i++) {
    try {
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts[i],
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new Error(`No embedding returned for item ${i}`);
      }

      // L2正規化して保存
      embeddings.push(l2Normalize(embedding));

      if ((i + 1) % 10 === 0) {
        console.log(`Generated embeddings: ${i + 1}/${texts.length}`);
      }
    } catch (error) {
      console.error(`Error generating embedding for item ${i}:`, error);
      throw error;
    }
  }

  return embeddings;
}

/**
 * JSONファイルからデータを読み込む
 */
function loadJSONFile(filePath: string): Record<string, string | undefined>[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`JSON file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content);

  // 配列の場合
  if (Array.isArray(data)) {
    return data;
  }

  // オブジェクトでitemsキーがある場合
  if (data.items && Array.isArray(data.items)) {
    return data.items;
  }

  // オブジェクトでqaキーがある場合
  if (data.qa && Array.isArray(data.qa)) {
    return data.qa;
  }

  throw new Error('Invalid JSON format. Expected array or object with "items" or "qa" key');
}

/**
 * JSON APIからデータを取得
 */
async function fetchJSON(url: string): Promise<Record<string, string | undefined>[]> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            // 配列の場合
            if (Array.isArray(json)) {
              resolve(json);
            }
            // オブジェクトでitemsキーがある場合
            else if (json.items && Array.isArray(json.items)) {
              resolve(json.items);
            }
            // オブジェクトでqaキーがある場合
            else if (json.qa && Array.isArray(json.qa)) {
              resolve(json.qa);
            } else {
              reject(new Error('Invalid JSON format. Expected array or object with "items" or "qa" key'));
            }
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

/**
 * メイン処理
 */
async function main() {
  console.log('Starting sync...');

  // データソースの優先順位: SHEET_CSV_URL > JSON > Excel
  const csvUrl = process.env.SHEET_CSV_URL;
  const jsonPath = process.env.QA_JSON_PATH;
  const jsonUrl = process.env.QA_JSON_URL;
  const xlsxPath = process.env.SHEET_XLSX_PATH;

  // データ取得
  let rows: Record<string, string | undefined>[];

  if (csvUrl) {
    // CSV URLから取得（最優先）
    console.log(`Fetching CSV from: ${csvUrl}`);
    const csvContent = await fetchCSV(csvUrl);
    rows = parseCSV(csvContent);
  } else if (jsonPath) {
    // JSONファイルから読み込み
    console.log(`Loading JSON from: ${jsonPath}`);
    rows = loadJSONFile(jsonPath);
  } else if (jsonUrl) {
    // JSON APIから取得
    console.log(`Fetching JSON from: ${jsonUrl}`);
    rows = await fetchJSON(jsonUrl);
  } else if (xlsxPath) {
    // Excelファイルから読み込み
    console.log(`Reading Excel from: ${xlsxPath}`);
    rows = parseExcel(xlsxPath);
  } else {
    throw new Error(
      'No data source specified. Set one of: SHEET_CSV_URL, QA_JSON_PATH, QA_JSON_URL, or SHEET_XLSX_PATH'
    );
  }

  console.log(`Loaded ${rows.length} rows from data source`);

  // 正規化
  const normalized = normalizeRows(rows);
  console.log(`Normalized to ${normalized.length} Q&A pairs`);

  if (normalized.length === 0) {
    throw new Error('No valid Q&A pairs found after normalization');
  }

  // data/qa_raw.json に保存
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const rawPath = path.join(dataDir, 'qa_raw.json');
  fs.writeFileSync(rawPath, JSON.stringify(normalized, null, 2), 'utf-8');
  console.log(`Saved normalized data to: ${rawPath}`);

  // Embedding生成用のテキストを作成（question + keywords + category）
  const texts = normalized.map((qa) => {
    const parts: string[] = [qa.question];
    if (qa.keywords) parts.push(qa.keywords);
    if (qa.category) parts.push(qa.category);
    return parts.join(' ');
  });

  console.log('Generating embeddings...');
  const embeddings = await generateEmbeddings(texts);

  // インデックスアイテムを作成
  const items: QAIndexItem[] = normalized.map((qa, i) => {
    const id = fnv1aHash(qa.question + qa.answer);
    return {
      id,
      question: qa.question,
      answer: qa.answer,
      meta: {
        category: qa.category,
        keywords: qa.keywords,
      },
      emb: embeddings[i],
    };
  });

  // インデックスを作成
  const index: QAIndex = {
    generatedAt: new Date().toISOString(),
    embeddingModel: EMBEDDING_MODEL,
    count: items.length,
    items,
  };

  // data/qa_index.json に保存
  const indexPath = path.join(dataDir, 'qa_index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  console.log(`Saved index to: ${indexPath}`);
  console.log(`Sync completed! Generated ${items.length} embeddings.`);
}

main().catch((error) => {
  console.error('Sync failed:', error);
  process.exit(1);
});


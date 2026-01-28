/**
 * プロンプトインジェクション対策
 * ユーザー入力をサニタイズしてLLMへの悪意ある操作を防ぐ
 */

// 危険なパターン（プロンプトインジェクションの試み）
const DANGEROUS_PATTERNS = [
  // 直接的な指示の上書き試行
  /ignore\s*(all\s*)?(previous|above|prior)\s*(instructions?|prompts?|rules?)/i,
  /disregard\s*(all\s*)?(previous|above|prior)\s*(instructions?|prompts?|rules?)/i,
  /forget\s*(all\s*)?(previous|above|prior)\s*(instructions?|prompts?|rules?)/i,

  // 日本語版
  /無視(して|しろ|せよ)/i,
  /忘れ(て|ろ|よ)/i,
  /(指示|ルール|制約)を(変更|破棄|無効)/i,

  // ロール変更の試行
  /you\s*are\s*(now|actually|really)/i,
  /pretend\s*(to\s*be|you\s*are)/i,
  /act\s*as\s*(if|though)/i,
  /role\s*play\s*as/i,

  // システムプロンプトの抽出試行
  /what\s*(are|is)\s*(your|the)\s*(instructions?|prompts?|rules?|system)/i,
  /show\s*(me\s*)?(your|the)\s*(instructions?|prompts?|rules?|system)/i,
  /reveal\s*(your|the)\s*(instructions?|prompts?|rules?|system)/i,

  // 日本語版
  /(システム|秘密|内部)(の)?(プロンプト|指示|設定)/i,
  /(教えて|見せて|表示)(ください)?.*?(プロンプト|指示|設定)/i,
];

// 危険な制御文字・特殊文字
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// 過度な繰り返し（DoS対策）
const EXCESSIVE_REPETITION = /(.)\1{20,}/;

/**
 * ユーザー入力をサニタイズ
 * @param input ユーザーからの入力
 * @returns サニタイズされた入力
 */
export function sanitizeInput(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  let sanitized = input;

  // 制御文字を除去
  sanitized = sanitized.replace(CONTROL_CHARS, '');

  // 過度な空白を正規化
  sanitized = sanitized.replace(/\s{10,}/g, ' '.repeat(5));

  // 過度な繰り返しを短縮
  if (EXCESSIVE_REPETITION.test(sanitized)) {
    sanitized = sanitized.replace(/(.)\1{20,}/g, '$1'.repeat(10));
  }

  // 入力長の制限（5000文字）
  if (sanitized.length > 5000) {
    sanitized = sanitized.slice(0, 5000);
  }

  return sanitized.trim();
}

/**
 * プロンプトインジェクションの可能性をチェック
 * @param input ユーザーからの入力
 * @returns 危険なパターンが見つかった場合はtrue
 */
export function detectPromptInjection(input: string): boolean {
  if (!input || typeof input !== 'string') {
    return false;
  }

  const lowerInput = input.toLowerCase();

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(lowerInput)) {
      return true;
    }
  }

  return false;
}

/**
 * ユーザー入力を安全にプロンプトに埋め込むためのエスケープ
 * @param input ユーザーからの入力
 * @returns エスケープされた入力
 */
export function escapeForPrompt(input: string): string {
  const sanitized = sanitizeInput(input);

  // プロンプト区切り文字として使われる可能性のある文字をエスケープ
  return sanitized
    .replace(/```/g, '` ` `')
    .replace(/---/g, '- - -')
    .replace(/###/g, '# # #');
}

/**
 * 安全なユーザーメッセージセクションを生成
 * @param message ユーザーからのメッセージ
 * @returns 安全にラップされたメッセージ
 */
export function wrapUserMessage(message: string): string {
  const sanitized = sanitizeInput(message);
  const escaped = escapeForPrompt(sanitized);

  return `<user_message>
${escaped}
</user_message>`;
}

/**
 * LLM出力の事後フィルタリング
 * 危険なコンテンツを含む場合は代替メッセージを返す
 * @param output LLMからの出力
 * @returns フィルタリングされた出力
 */
export function filterLLMOutput(output: string): string {
  if (!output || typeof output !== 'string') {
    return '';
  }

  // 機密情報の漏洩パターンをチェック
  const sensitivePatterns = [
    /OPENAI_API_KEY/i,
    /LINE_CHANNEL_SECRET/i,
    /LINE_CHANNEL_ACCESS_TOKEN/i,
    /sk-[a-zA-Z0-9]{20,}/i, // OpenAI APIキーパターン
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(output)) {
      return 'お答えできない内容が含まれていました。別の質問をお試しください。';
    }
  }

  return output;
}

/**
 * 入力の安全性レポートを生成
 * @param input ユーザーからの入力
 * @returns 安全性レポート
 */
export function analyzeInputSafety(input: string): {
  isSafe: boolean;
  sanitized: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const sanitized = sanitizeInput(input);

  if (input !== sanitized) {
    warnings.push('入力がサニタイズされました');
  }

  if (detectPromptInjection(input)) {
    warnings.push('プロンプトインジェクションの可能性を検出');
  }

  if (EXCESSIVE_REPETITION.test(input)) {
    warnings.push('過度な繰り返しを検出');
  }

  if (input.length > 5000) {
    warnings.push('入力が長すぎるため切り詰められました');
  }

  return {
    isSafe: warnings.length === 0,
    sanitized,
    warnings,
  };
}

/**
 * Wire contract between the deepseek-web adapter (inside the dsh runtime) and
 * the extension's model-relay endpoint (NDJSON over one HTTP POST).
 *
 * Request body:  RelayRequest (JSON)
 * Response body: one RelayEvent per line, stream ends after 'finish'/'error'.
 */

export interface RelayRequest {
  /** Fully composed user-side prompt text for this turn. */
  prompt: string;
  /** DeepSeek web model mode: 'expert' | 'vision'. */
  modelType?: string;
  /** The dsh session that owns this generation — used to isolate web chains. */
  dshSessionId?: string;
  /**
   * Attached images for this turn (base64, JSON-safe). The consumer uploads
   * each via /api/v0/file/upload_file and passes the ids as refFileIds —
   * the web completion never takes inline image bytes.
   */
  images?: RelayImage[];
}

/** One attached image traveling with a relay ticket. */
export interface RelayImage {
  /** Raw bytes, base64-encoded. */
  dataBase64: string;
  /** Original filename (falls back to the attachment id). */
  filename: string;
  /** MIME type, e.g. image/png. */
  mimeType: string;
}

export type RelayEvent =
  | { t: 'text'; delta: string }
  | { t: 'reasoning'; delta: string }
  | { t: 'usage'; inputTokens?: number; outputTokens?: number }
  | { t: 'finish' }
  | { t: 'error'; code: string; message: string };

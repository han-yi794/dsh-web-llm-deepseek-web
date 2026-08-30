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
}

export type RelayEvent =
  | { t: 'text'; delta: string }
  | { t: 'reasoning'; delta: string }
  | { t: 'usage'; inputTokens?: number; outputTokens?: number }
  | { t: 'finish' }
  | { t: 'error'; code: string; message: string };

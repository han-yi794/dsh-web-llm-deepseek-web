// Ported from deepseek-pp `core/deepseek/active-client.ts` + `automation-client-port.ts`
// (https://github.com/zhu1090093659/deepseek-pp @ 0a02c72b135bf2936e11aa78fd6136931ed65908).
// Upstream is Apache-2.0 — see NOTICE.md in this repository.
// Local modifications:
// - file upload paths restored for the multimodal milestone
//   (uploadDeepSeekFile + readiness wait; ported from upstream active-client.ts);
// - token-speed tracker removed (re-added when the sidepanel lands);
// - upstream's network-policy module replaced by a local fetch wrapper that
//   keeps the same wire behavior plus a response byte-budget abort guard.

import {
  consumeDeepSeekSseEvents,
  createDeepSeekSseByteDecoder,
  createDeepSeekStreamSummary,
  type DeepSeekStreamSummary,
  type SSEEvent,
} from './stream-codec.ts';
import { solvePowChallengeLocally, type PowAnswer, type PowChallenge, type DeepSeekPowWasmSource } from './pow.ts';
import {
  DEEPSEEK_BODY_BUDGETS,
  DEEPSEEK_BYPASS_HOOK_HEADER,
  DEEPSEEK_WEB_ORIGIN,
  DEEPSEEK_WEB_ROUTES,
  buildDeepSeekWebSessionUrl,
  encodeCreateSessionRequest,
  encodeCompletionRequest,
  encodeDeepSeekRouteRequest,
  encodeHistoryRequest,
  encodePowChallengeRequest,
  normalizeDeepSeekMessageId,
  normalizeDeepSeekModelType,
} from './routes.ts';
import {
  DeepSeekAuthError,
  DeepSeekPayloadError,
  DeepSeekPowError,
  DeepSeekSessionError,
} from './errors.ts';

const COMPLETION_PATH = DEEPSEEK_WEB_ROUTES.completion;
const DEFAULT_APP_VERSION = '2.0.0';
const DEEPSEEK_CLIENT_PLATFORM = 'web';
const USER_TOKEN_STORAGE_KEY = 'userToken';

let rememberedClientHeaders: Record<string, string> | null = null;

// ── Global request gate (pp-style anti-burst) ───────────────────────────────
// chat.deepseek.com rate-limits bursty traffic: an agent run fires many LLM
// calls in a row (session create, PoW challenge, completion), and multiple
// dsh sessions can generate concurrently. Every request funnels through
// requestDeepSeek, so a single chain-gated minimum interval keeps the wire
// traffic spaced out without per-caller coordination.
let deepSeekRequestTail: Promise<void> = Promise.resolve();
let lastDeepSeekRequestAt = 0;
let deepSeekRequestMinIntervalMs = 2_500;

/** Override the minimum spacing between any two DeepSeek web requests. */
export function setDeepSeekRequestMinInterval(intervalMs: number): void {
  deepSeekRequestMinIntervalMs = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : 0;
}

/** Abortable sleep (same shape as the adapter's pacing helper). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(cleanup, ms);
    const onAbort = () => cleanup();
    function cleanup(): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Chain-gated minimum interval: serializes concurrent requests and spaces them. */
async function gateDeepSeekRequest(signal?: AbortSignal): Promise<void> {
  const prev = deepSeekRequestTail;
  let release!: () => void;
  deepSeekRequestTail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await prev;
    const elapsed = Date.now() - lastDeepSeekRequestAt;
    if (elapsed < deepSeekRequestMinIntervalMs) {
      await sleep(deepSeekRequestMinIntervalMs - elapsed, signal);
    }
    lastDeepSeekRequestAt = Date.now();
  } finally {
    // Guarantee the chain always advances — even on abort — so a cancelled
    // request can never wedge every later DeepSeek web request.
    release();
  }
}

/** Restores the verbatim captured header set after a service-worker restart
 *  (MV3 kills idle SWs, wiping module memory — pitfall A3: storage is the
 *  warm-start mirror, in-memory map is the truth only while alive). */
export function restoreRememberedClientHeaders(headers: Record<string, string> | null | undefined): void {
  if (headers && typeof headers === 'object') {
    rememberedClientHeaders = { ...headers };
  }
}

let injectedToken: string | null = null;

/** Service workers have no localStorage; the content script bridges the page token here. */
export function setInjectedUserToken(token: string): void {
  injectedToken = token;
}

export interface ModelTurn {
  assistantText: string;
  responseMessageId: number | null;
  requestMessageId: number | null;
  finished: boolean;
}

export interface DeepSeekHistorySnapshot {
  chatSessionId: string;
  parentMessageId: number | null;
  assistantMessageId: number | null;
  messageCount: number;
  verifiedAt: number;
}

export interface SubmitPromptInput {
  chatSessionId: string;
  parentMessageId: number | null;
  modelType: string | null;
  prompt: string;
  refFileIds: string[];
  thinkingEnabled: boolean;
  searchEnabled: boolean;
  clientHeaders: Record<string, string>;
  powHeaders: Record<string, string>;
}

export interface DeepSeekRequestContext {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface StreamCallbacks {
  onTextChunk?(text: string, fullText: string): void;
  /** Reasoning/thinking deltas of the current response (THINK fragments). */
  onReasoningChunk?(reasoning: string, fullReasoning: string): void;
  onFinished?(): void;
  retainAssistantText?: boolean;
}

interface DeepSeekHistoryMessage {
  id: number | null;
  parentId: number | null;
  role: string | null;
}

export function createClientHeaders(options?: {
  missingTokenMessage?: string;
  /** Raw Cookie header captured from a logged-in browser context (Node has no cookie jar). */
  cookie?: string;
  /** Force-drop the Authorization header (anonymous cookie-only sessions). */
  omitBearer?: boolean;
}): Record<string, string> {
  if (rememberedClientHeaders) {
    // Strip stale PoW response headers from the captured set: PoW answers are
    // per-request, generated fresh in createPowHeaders. A remembered
    // x-ds-pow-response is a snapshot of a previous request's answer and must
    // never be replayed (relay-consumer deletes these before every call —
    // mirror that here so every consumer gets clean headers).
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rememberedClientHeaders)) {
      if (/pow/i.test(key)) continue;
      headers[key] = value;
    }
    return headers;
  }

  const token = injectedToken ?? readDeepSeekUserToken();
  if (!token) {
    throw new DeepSeekAuthError(
      options?.missingTokenMessage ?? 'DeepSeek login token is missing. Refresh chat.deepseek.com or sign in again.',
    );
  }

  const headers: Record<string, string> = {
    // Browser-like statics: the API/WAF rejects bare-node clients.
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
    Accept: '*/*',
    Origin: DEEPSEEK_WEB_ORIGIN,
    Referer: `${DEEPSEEK_WEB_ORIGIN}/`,
    'X-App-Version': getDeepSeekAppVersion(),
    'x-client-platform': DEEPSEEK_CLIENT_PLATFORM,
    'x-client-version': getDeepSeekAppVersion(),
    'x-client-locale': getDeepSeekLocale(),
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
  // Anonymous/guest sessions store a non-JWT marker in localStorage.userToken
  // (observed: {"value":0}-style); sending it as Bearer gets rejected, while
  // cookie-only auth passes. Real login tokens are long opaque strings.
  const looksLikeJwtish = token.length > 64 && !token.startsWith('{');
  if (looksLikeJwtish && !options?.omitBearer) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options?.cookie) headers.Cookie = options.cookie;
  return headers;
}

/** Remembers auth headers captured from a real page request (fetch-hook path). */
export function rememberDeepSeekClientHeaders(headersInit: HeadersInit | undefined): void {
  const headers = normalizeHeaders(headersInit);
  if (!headers) return;

  const authorization = headers.get('authorization');
  if (!authorization) return;

  // Preserve EVERY captured header verbatim, not just a whitelist: DeepSeek's
  // WAF/session validation keys off the full set (content-type, accept,
  // x-client-bundle-id, x-hif-* …). A partial reconstruction (M2: only the
  // Bearer + platform headers) fails with 40002 Missing Token even with a
  // valid token — the captured set must pass through unchanged.
  const captured: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (value !== '') captured[key] = value;
  });
  rememberedClientHeaders = captured;
}

export async function createChatSession(
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await requestDeepSeek(
    encodeCreateSessionRequest(clientHeaders),
    'DeepSeek chat session create',
    'session',
    signal,
  );
  const json = await readJsonResponse(response, 'DeepSeek chat session create', 'session');
  const data = json?.data;
  const chatSessionId = firstString(data?.biz_data?.chat_session?.id);

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while creating chat session: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0 || !chatSessionId) {
    throw new DeepSeekSessionError(`Failed to create DeepSeek chat session: ${JSON.stringify(data ?? json)}`);
  }

  return chatSessionId;
}

export async function createPowHeaders(
  clientHeaders: Record<string, string>,
  targetPath: string = COMPLETION_PATH,
  wasm?: DeepSeekPowWasmSource | string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  try {
    const challenge = await createPowChallenge(clientHeaders, targetPath, signal);
    assertSignalActive(signal);
    const wasmSource: DeepSeekPowWasmSource | undefined =
      wasm === undefined ? undefined : typeof wasm === 'string' ? { kind: 'url', url: wasm } : wasm;
    let answer: PowAnswer;
    try {
      answer = await solvePowChallengeLocally(challenge, wasmSource, signal);
    } catch (err) {
      throw new DeepSeekPowError(`DeepSeek PoW challenge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    assertSignalActive(signal);
    return {
      'X-DS-PoW-Response': base64EncodeUtf8(JSON.stringify({
        algorithm: answer.algorithm,
        challenge: answer.challenge,
        salt: answer.salt,
        answer: answer.answer,
        signature: answer.signature,
        target_path: targetPath,
      })),
    };
  } catch (err) {
    if (err instanceof DeepSeekPowError || err instanceof DeepSeekAuthError) throw err;
    throw new DeepSeekPowError(err instanceof Error ? err.message : String(err));
  }
}

export async function submitPrompt(
  input: SubmitPromptInput,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<ModelTurn> {
  const response = await requestCompletion(input, signal);

  if (!response.ok) {
    throw new DeepSeekPayloadError(await readFailureMessage(response), { retryable: true });
  }

  if (!response.body) {
    throw new DeepSeekPayloadError('DeepSeek completion response did not include a stream body.', { retryable: true });
  }

  return readCompletionStream(response, callbacks);
}

async function requestCompletion(input: SubmitPromptInput, signal?: AbortSignal): Promise<Response> {
  return requestDeepSeek(encodeCompletionRequest(input), 'DeepSeek completion', 'completion', signal);
}

export async function readHistorySnapshot(
  chatSessionId: string,
  expectedAssistantMessageId: number,
  clientHeadersOverride?: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekHistorySnapshot | null> {
  const clientHeaders = clientHeadersOverride ?? createClientHeaders();
  const response = await requestDeepSeek(
    encodeHistoryRequest(chatSessionId, clientHeaders),
    'DeepSeek history',
    'history',
    signal,
  );
  if (!response.ok) {
    await cancelResponseBody(response);
    return null;
  }

  const json = await readJsonResponse(response, 'DeepSeek history', 'payload');
  const data = json?.data?.biz_data ?? json?.data ?? json?.biz_data ?? json;
  const rawMessages: unknown[] = Array.isArray(data?.chat_messages) ? data.chat_messages : [];
  if (rawMessages.length === 0) return null;

  const messages = rawMessages
    .map((message: unknown) => normalizeHistoryMessage(message))
    .filter((message: DeepSeekHistoryMessage): message is DeepSeekHistoryMessage => message.id !== null);
  if (messages.length === 0) return null;

  const expected = messages.find((message) => message.id === expectedAssistantMessageId);
  const fallback =
    [...messages].reverse().find((message) => message.role !== 'user')
    ?? messages[messages.length - 1];
  const latestAssistant = expected ?? fallback;
  if (!latestAssistant || latestAssistant.id === null) return null;

  return {
    chatSessionId,
    parentMessageId: latestAssistant.id,
    assistantMessageId: latestAssistant.id,
    messageCount: messages.length,
    verifiedAt: Date.now(),
  };
}

export function normalizeMessageId(value: unknown, fieldName = 'message_id'): number | null {
  const id = normalizeDeepSeekMessageId(value);
  if (id !== null || value === null || value === undefined || value === '') return id;
  throw new DeepSeekPayloadError(`DeepSeek ${fieldName} must be a u32 number, received ${JSON.stringify(value)}.`);
}

export function buildSessionUrl(chatSessionId: string): string {
  return buildDeepSeekWebSessionUrl(chatSessionId);
}

async function readCompletionStream(response: Response, callbacks: StreamCallbacks): Promise<ModelTurn> {
  const reader = response.body!.getReader();
  const decoder = createDeepSeekSseByteDecoder();
  const summary: DeepSeekStreamSummary & ModelTurn = createDeepSeekStreamSummary();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const newText = consumeDeepSeekSseEvents(decoder.push(value), summary, {
      retainAssistantText: callbacks.retainAssistantText,
      onReasoningChunk: callbacks.onReasoningChunk,
    });
    if (newText && callbacks.onTextChunk) {
      callbacks.onTextChunk(newText, summary.assistantText);
    }
  }

  const finalText = consumeDeepSeekSseEvents(decoder.finish(), summary, {
    retainAssistantText: callbacks.retainAssistantText,
    onReasoningChunk: callbacks.onReasoningChunk,
  });
  if (finalText && callbacks.onTextChunk) {
    callbacks.onTextChunk(finalText, summary.assistantText);
  }

  callbacks.onFinished?.();
  return summary;
}

function normalizeHistoryMessage(raw: unknown): DeepSeekHistoryMessage {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    id: firstMessageId(value.message_id, value.id, value.uuid),
    parentId: firstMessageId(value.parent_id, value.parent_message_id, value.parentMessageId),
    role: firstString(value.message_role, value.role)?.toLowerCase() ?? null,
  };
}

function readDeepSeekUserToken(): string | null {
  try {
    const raw = localStorage.getItem(USER_TOKEN_STORAGE_KEY);
    if (!raw) return null;

    const parsed = tryParseJson(raw);
    if (typeof parsed === 'string') return parsed.trim() || null;
    if (parsed && typeof parsed === 'object') {
      return firstString(
        (parsed as Record<string, unknown>).token,
        (parsed as Record<string, unknown>).value,
        (parsed as Record<string, unknown>).accessToken,
      );
    }

    if (raw.trim() === 'null') return null;
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function normalizeHeaders(headersInit: HeadersInit | undefined): Headers | null {
  if (!headersInit) return null;
  try {
    return new Headers(headersInit);
  } catch {
    return null;
  }
}

function getDeepSeekAppVersion(): string {
  return DEFAULT_APP_VERSION;
}

function getDeepSeekLocale(): string {
  if (typeof document !== 'undefined' && document.documentElement?.lang) {
    return document.documentElement.lang;
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'en-US';
}

async function createPowChallenge(
  clientHeaders: Record<string, string>,
  targetPath: string,
  signal?: AbortSignal,
): Promise<PowChallenge> {
  const response = await requestDeepSeek(
    encodePowChallengeRequest(clientHeaders, targetPath),
    'DeepSeek PoW challenge',
    'pow',
    signal,
  );
  // HTTP 401/403 means the token itself was rejected; classify as auth so the
  // caller refreshes credentials instead of retry-storming PoW failures.
  if (response.status === 401 || response.status === 403) {
    throw new DeepSeekAuthError(
      `DeepSeek auth token was rejected (HTTP ${response.status}) while creating PoW challenge.`,
    );
  }
  const json = await readJsonResponse(response, 'DeepSeek PoW challenge', 'pow');
  const data = json?.data;
  const challenge = data?.biz_data?.challenge;

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while creating PoW challenge: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0 || !challenge) {
    throw new DeepSeekPowError(`Failed to create DeepSeek PoW challenge: ${JSON.stringify(data ?? json)}`);
  }

  return {
    algorithm: String(challenge.algorithm),
    challenge: String(challenge.challenge),
    salt: String(challenge.salt),
    difficulty: Number(challenge.difficulty),
    signature: String(challenge.signature),
    expireAt: Number(challenge.expire_at ?? challenge.expireAt ?? 0),
    expireAfter: Number(challenge.expire_after ?? challenge.expireAfter ?? 0),
  };
}

function isAuthBizError(data: any, json: any): boolean {
  return data?.biz_code === 40002 || data?.biz_code === 40003 || json?.code === 40002 || json?.code === 40003;
}

async function readFailureMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return text || `DeepSeek completion failed with HTTP ${response.status}.`;
}

type DeepSeekJsonErrorKind = 'payload' | 'pow' | 'session' | 'upload';

async function readJsonResponse(
  response: Response,
  label: string,
  errorKind: DeepSeekJsonErrorKind,
): Promise<any> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    const message = `${label} returned non-JSON HTTP ${response.status}: ${preview || response.statusText}`;
    if (errorKind === 'pow') throw new DeepSeekPowError(message);
    if (errorKind === 'session') throw new DeepSeekSessionError(message);
    throw new DeepSeekPayloadError(message, { retryable: response.status >= 500 });
  }
}

// ── File upload (multimodal milestone; ported from upstream active-client.ts) ─
// Images ride the web completion as uploaded file references (`refFileIds`),
// so every image block is uploaded first via /api/v0/file/upload_file and
// polled until the server marks it ready.

/** Hard cap for one uploaded image (upstream upload-limits). */
export const DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

const FILE_READY_POLL_INTERVAL_MS = 500;
const FILE_READY_TIMEOUT_MS = 15_000;

const ACCEPTED_FILE_AUDIT_RESULTS = new Set(['PASS', 'PASSED', 'SUCCESS', 'OK', 'UNKNOWN']);
const REJECTED_FILE_AUDIT_RESULTS = new Set(['REJECT', 'REJECTED', 'FAIL', 'FAILED', 'ERROR', 'BLOCK', 'BLOCKED', 'DENY', 'DENIED']);

/** One uploaded web file as the completion API references it. */
export interface DeepSeekUploadedFile {
  id: string;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  status: string | null;
  signedPath: string | null;
  auditResult: string | null;
  retryable: boolean | null;
  width: number | null;
  height: number | null;
}

/** Image upload request: raw file bytes plus the auth of the owning session. */
export interface DeepSeekFileUploadInput {
  file: Blob;
  filename: string;
  modelType: string | null;
  clientHeaders: Record<string, string>;
  powHeaders: Record<string, string>;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function normalizeUploadedFile(raw: unknown): DeepSeekUploadedFile | null {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const id = firstString(value.id, value.file_id, value.fileId);
  if (!id) return null;

  return {
    id,
    fileName: firstString(value.file_name, value.fileName, value.name),
    fileSize: firstFiniteNumber(value.file_size, value.fileSize, value.size),
    mimeType: firstString(value.mime_type, value.mimeType),
    status: firstString(value.status),
    signedPath: firstString(value.signed_path, value.signedPath),
    auditResult: firstString(value.audit_result, value.auditResult),
    retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
    width: firstFiniteNumber(value.width),
    height: firstFiniteNumber(value.height),
  };
}

function normalizeFileAuditResult(file: DeepSeekUploadedFile): string | null {
  const auditResult = file.auditResult?.trim();
  return auditResult ? auditResult.toUpperCase() : null;
}

function isUploadedFileAuditAccepted(file: DeepSeekUploadedFile): boolean {
  const auditResult = normalizeFileAuditResult(file);
  return !auditResult || ACCEPTED_FILE_AUDIT_RESULTS.has(auditResult);
}

function isUploadedFileAuditRejected(file: DeepSeekUploadedFile): boolean {
  const auditResult = normalizeFileAuditResult(file);
  return auditResult ? REJECTED_FILE_AUDIT_RESULTS.has(auditResult) : false;
}

function isUploadedFileReady(file: DeepSeekUploadedFile): boolean {
  const status = file.status?.toUpperCase();
  return status === 'SUCCESS' && isUploadedFileAuditAccepted(file);
}

function assertUploadedFileNotRejected(file: DeepSeekUploadedFile): void {
  const status = file.status?.toUpperCase();
  if (isUploadedFileAuditRejected(file)) {
    throw new DeepSeekPayloadError(`DeepSeek rejected ${file.fileName ?? file.id}: audit_result=${file.auditResult}.`);
  }
  if (status === 'FAILED' || status === 'FAIL' || status === 'ERROR') {
    throw new DeepSeekPayloadError(`DeepSeek failed to process ${file.fileName ?? file.id}: status=${file.status}.`, {
      retryable: file.retryable ?? false,
    });
  }
}

/**
 * Upload one image file for later reference by a completion (`refFileIds`).
 * Waits until the server marks the file ready before returning its id.
 */
export async function uploadDeepSeekFile(
  input: DeepSeekFileUploadInput,
  signal?: AbortSignal,
): Promise<DeepSeekUploadedFile> {
  if (!input.file.type.startsWith('image/')) {
    throw new DeepSeekPayloadError(`${input.filename} is not an image file.`);
  }
  if (input.file.size > DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES) {
    throw new DeepSeekPayloadError(`${input.filename} exceeds the ${formatBytes(DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES)} image upload limit.`);
  }

  const form = new FormData();
  form.append('file', input.file, input.filename);

  // The captured browser headers may carry a stale content-type (with the
  // page's own multipart boundary) — drop content headers so fetch derives
  // a fresh boundary from THIS FormData, otherwise the server rejects with
  // "Invalid `boundary` for `multipart/form-data` request".
  const uploadHeaders: Record<string, string> = { ...input.clientHeaders };
  for (const key of Object.keys(uploadHeaders)) {
    if (/^(content-type|content-length)$/i.test(key)) delete uploadHeaders[key];
  }

  const response = await requestDeepSeek(
    encodeDeepSeekRouteRequest('uploadFile', {
      credentials: 'include',
      headers: {
        [DEEPSEEK_BYPASS_HOOK_HEADER]: '1',
        ...uploadHeaders,
        ...input.powHeaders,
        'x-thinking-enabled': '0',
        'x-model-type': normalizeDeepSeekModelType(input.modelType),
        'x-file-size': String(input.file.size),
      },
      body: form,
    }),
    'DeepSeek file upload',
    'upload',
    signal,
  );

  const json = await readJsonResponse(response, 'DeepSeek file upload', 'upload');
  const data = json?.data;
  const bizData = data?.biz_data ?? data?.bizData ?? json?.biz_data ?? json?.bizData;
  const uploaded = normalizeUploadedFile(bizData);

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while uploading file: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0 || !uploaded) {
    throw new DeepSeekPayloadError(`Failed to upload DeepSeek file: ${JSON.stringify(data ?? json)}`, { retryable: true });
  }

  return waitForUploadedFileReady(uploaded, input.clientHeaders, signal);
}

async function fetchUploadedFileMetadata(
  fileId: string,
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekUploadedFile | null> {
  const response = await requestDeepSeek(
    encodeDeepSeekRouteRequest('fetchFiles', {
      credentials: 'include',
      headers: {
        accept: 'application/json',
        [DEEPSEEK_BYPASS_HOOK_HEADER]: '1',
        ...clientHeaders,
      },
    }, { searchParams: { file_ids: fileId } }),
    'DeepSeek file metadata',
    'upload',
    signal,
  );

  const json = await readJsonResponse(response, 'DeepSeek file metadata', 'upload');
  const data = json?.data;
  const bizData = data?.biz_data ?? data?.bizData ?? json?.biz_data ?? json?.bizData;
  const files = Array.isArray(bizData?.files) ? bizData.files : [];
  const file = files
    .map((item: unknown) => normalizeUploadedFile(item))
    .find((item: DeepSeekUploadedFile | null): item is DeepSeekUploadedFile => item?.id === fileId);

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while fetching file metadata: ${JSON.stringify(data ?? json)}`);
  }

  return file ?? null;
}

async function waitForUploadedFileReady(
  uploaded: DeepSeekUploadedFile,
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekUploadedFile> {
  assertUploadedFileNotRejected(uploaded);
  if (isUploadedFileReady(uploaded)) return uploaded;
  if (!uploaded.status) return uploaded;

  const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
  let latest = uploaded;
  while (Date.now() < deadline) {
    await sleep(FILE_READY_POLL_INTERVAL_MS, signal);
    const next = await fetchUploadedFileMetadata(uploaded.id, clientHeaders, signal);
    if (!next) continue;
    latest = next;
    assertUploadedFileNotRejected(latest);
    if (isUploadedFileReady(latest)) return latest;
  }

  throw new DeepSeekPayloadError(
    `DeepSeek file ${uploaded.fileName ?? uploaded.id} is still processing after ${Math.round(FILE_READY_TIMEOUT_MS / 1000)}s.`,
    { retryable: true },
  );
}

/**
 * Fetch wrapper keeping upstream semantics: credentials include, caller signal
 * honored, and a hard response byte budget that aborts instead of buffering
 * without bound (upstream enforced this in its network-policy module).
 */
async function requestDeepSeek(
  request: { url: string; init: RequestInit },
  _operation: string,
  phase: 'session' | 'pow' | 'completion' | 'history' | 'upload',
  signal?: AbortSignal,
): Promise<Response> {
  // pp-style anti-burst: every DeepSeek web request waits its turn through the
  // global gate so session/PoW/completion calls and concurrent sessions never
  // pile onto chat.deepseek.com faster than the minimum interval.
  await gateDeepSeekRequest(signal);

  const maxResponseBytes = phase === 'completion'
    ? DEEPSEEK_BODY_BUDGETS.activeCompletion
    : DEEPSEEK_BODY_BUDGETS.activeJson;

  if (phase !== 'completion') return doFetch(request, signal);

  // Completion streams are consumed by the caller; enforce the budget there
  // by handing back a response whose stream aborts past the limit.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  const response = await doFetch(request, controller.signal);

  if (!response.body) return response;

  let total = 0;
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        signal?.removeEventListener('abort', onOuterAbort);
        return;
      }
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        signal?.removeEventListener('abort', onOuterAbort);
        controller.error(new DeepSeekPayloadError('DeepSeek completion exceeded the response byte budget.'));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      signal?.removeEventListener('abort', onOuterAbort);
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function doFetch(request: { url: string; init: RequestInit }, signal?: AbortSignal): Promise<Response> {
  return fetch(request.url, {
    ...request.init,
    // MV3 SW cross-origin fetches default to credentials: 'same-origin',
    // which omits cookies for chat.deepseek.com. The web session's auth
    // rides both a Bearer header AND cookies; include them explicitly.
    credentials: 'include',
    signal,
  });
}

function assertSignalActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('DeepSeek request was aborted.', 'AbortError');
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation racing stream close is expected; nothing else can reach it.
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstMessageId(...values: unknown[]): number | null {
  for (const value of values) {
    const id = normalizeDeepSeekMessageId(value);
    if (id !== null) return id;
  }
  return null;
}

function tryParseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  Message,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { GenerationTicket } from './relay-server.ts';
import type { RelayImage } from './wire-events.ts';
import { createStreamingXmlParser } from './xml-stream-parser.ts';
import type { StreamingXmlParser, ToolRejection, ToolRejectionReason } from './xml-stream-parser.ts';

const TEXT_INDEX = 0;
const REASONING_INDEX = 1;
const FIRST_TOOL_INDEX = 2;

// chat.deepseek.com exposes ONE model entry (built-in vision). The wire never
// names a model — the session is bound to your logged-in account — and the
// single model entry uses the `default` wire model_type.
const WEB_MODEL_ID = 'deepseek-web';
const WEB_MODEL_NAME = 'DeepSeek Web';

/** Map a catalog model id to the deepseek web wire `model_type`. */
function modelTypeForModel(_model: string | undefined): string {
  // Single web model entry; vision is built in. Always the default wire mode.
  return 'default';
}

/** Abortable sleep used by request pacing. */
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

export interface DeepSeekWebAdapterOptions {
  enqueue(request: { prompt: string; modelType?: string; dshSessionId?: string; images?: RelayImage[] }): GenerationTicket;
  /** Random pacing bounds between consecutive web requests (pp release pacing). */
  requestDelayMinMs: number;
  requestDelayMaxMs: number;
  /**
   * Append one automatic correction round when tool-call blocks were rejected
   * (reasons + the accepted form are fed back to the model). Default true.
   */
  toolRetryFeedback?: boolean;
  /** Resolve the harness attachment store (mirrors official adapters). */
  resolveAttachments?: () => unknown;
  /** Map a host path to a readable path (mirrors official adapters). */
  mapHostPath?: (hostPath: string) => string | undefined;
}

/** Minimal shape of a dsh image content block we resolve to bytes. */
interface WebImageRef {
  attachmentId?: string;
  name?: string;
  mediaType?: string;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function mimeTypeForImage(name: string, fallback?: string): string {
  if (fallback !== undefined && fallback !== '') return fallback;
  const lower = name.toLowerCase();
  for (const [extension, mime] of Object.entries(IMAGE_MIME_BY_EXTENSION)) {
    if (lower.endsWith(extension)) return mime;
  }
  return 'image/png';
}

/**
 * Collect attached images from model messages and resolve them to bytes via
 * the harness attachment store (same seam the official adapters use).
 * Returns base64 payloads for the relay ticket; the consumer uploads them
 * and passes the file ids as refFileIds.
 */
async function collectTicketImages(
  messages: readonly Message[],
  resolveAttachments: (() => unknown) | undefined,
  mapHostPath: ((hostPath: string) => string | undefined) | undefined,
): Promise<RelayImage[]> {
  const images: RelayImage[] = [];
  if (resolveAttachments === undefined) return images;
  const attachments = resolveAttachments() as {
    imageHostPath?: (ref: unknown) => string | undefined;
  } | null | undefined;
  if (attachments === null || attachments === undefined || typeof attachments.imageHostPath !== 'function') return images;

  for (const message of messages) {
    const shaped = message as { content?: unknown };
    if (!Array.isArray(shaped.content)) continue;
    for (const block of shaped.content) {
      if (block === null || typeof block !== 'object') continue;
      const typed = block as { type?: unknown; attachment?: unknown };
      if (typed.type !== 'image') continue;
      const ref = (typed.attachment ?? block) as WebImageRef;
      let hostPath: string | undefined;
      try {
        hostPath = attachments.imageHostPath(ref);
      } catch {
        continue;
      }
      if (hostPath === undefined) continue;
      const readonlyPath = mapHostPath !== undefined ? mapHostPath(hostPath) : hostPath;
      if (readonlyPath === undefined) continue;
      const bytes = await readFile(readonlyPath);
      const filename = ref.name ?? String(ref.attachmentId ?? 'image');
      images.push({
        dataBase64: bytes.toString('base64'),
        filename,
        mimeType: mimeTypeForImage(filename, ref.mediaType),
      });
    }
  }
  return images;
}

/**
 * Streams one web-session completion per model turn by handing the composed
 * prompt to the extension relay and mapping NDJSON wire events back to
 * official StreamChunks.
 *
 * Contract obligations honoured here (docs/cookbook/adding-an-llm-adapter):
 * - buffered `usage` is emitted immediately BEFORE `finish`, never after;
 * - transport faults throw LlmError with stable codes;
 * - caller cancellation exits silently (consumer owns interruption semantics);
 * - session-chain authority stays OUTSIDE the adapter (extension side feeds
 *   parentMessageId), so no native replayState projection yet;
 * - provider retry policy rides the official dsh-llm-retry plugin; failures
 *   that look rate-limited throw LlmError('RATE_LIMIT') for it to retry.
 */
export class DeepSeekWebAdapter extends LlmAdapter {
  readonly #enqueue: DeepSeekWebAdapterOptions['enqueue'];
  readonly #requestDelayMinMs: number;
  readonly #requestDelayMaxMs: number;
  readonly #toolRetryFeedback: boolean;
  readonly #retryPolicy: ResolvedRetryPolicy | undefined;
  readonly #resolveAttachments: (() => unknown) | undefined;
  readonly #mapHostPath: ((hostPath: string) => string | undefined) | undefined;
  /** Number of generations started; used to skip pacing before the first. */
  #requestCount = 0;

  constructor(options: DeepSeekWebAdapterOptions, retryPolicy?: ResolvedRetryPolicy) {
    super();
    this.#enqueue = options.enqueue;
    this.#requestDelayMinMs = options.requestDelayMinMs;
    this.#requestDelayMaxMs = options.requestDelayMaxMs;
    this.#toolRetryFeedback = options.toolRetryFeedback ?? true;
    this.#retryPolicy = retryPolicy;
    this.#resolveAttachments = options.resolveAttachments;
    this.#mapHostPath = options.mapHostPath;
  }

  /** Expose the provider retry policy to the official dsh-llm-retry plugin. */
  override providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return this.#retryPolicy;
  }

  /**
   * Advertise the provider route so the Web model selector lists
   * deepseek-web alongside the official and pi-ai routes.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek Web' };
  }

  /**
   * Advertise the single DeepSeek web model entry as an advisory catalog item.
   * The web session serves the logged-in account; the model entry uses the
   * `default` wire model_type. Absence is never a rejection — the adapter
   * accepts any model id.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      {
        provider,
        id: WEB_MODEL_ID,
        name: WEB_MODEL_NAME,
        description: 'DeepSeek 网页会话（内置视觉），免费，经 chat.deepseek.com 登录态。',
        inputModalities: ['text', 'image'],
      },
    ]);
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) return;

    const toolNames = new Set((options.tools ?? []).map(t => t.name));
    const hasTools = toolNames.size > 0;
    // One binding per generation: the instructions embed it, the parser
    // requires it back from any `<tool>` block that carries an explicit
    // `_nonce` field. A correction round reuses the SAME binding so the
    // feedback can restate it verbatim.
    const toolNonce = hasTools ? randomUUID().replace(/-/g, '') : undefined;
    const prompt = composeWebPrompt({ ...options, toolNonce });
    if (prompt === '') {
      throw new LlmError('deepseek-web requires a non-empty user message', 'EMPTY_PROMPT');
    }

    // Map the selected model id to the deepseek web wire model_type:
    // deepseek-expert → expert, deepseek-vision → vision; other ids → expert.
    const modelType = modelTypeForModel(options.model);
    // Resolve attached images once: only the first web request carries them
    // (the consumer uploads them via /api/v0/file/upload_file and references
    // them as refFileIds; the completion never takes inline image bytes).
    const images = await collectTicketImages(
      options.messages ?? [],
      this.#resolveAttachments,
      this.#mapHostPath,
    );

    const toolIndexState = { next: FIRST_TOOL_INDEX };
    const maxTurns = this.#toolRetryFeedback && hasTools ? 2 : 1;

    let turnPrompt = prompt;
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let rejections: readonly ToolRejection[] = [];

    for (let round = 0; round < maxTurns; round += 1) {
      const parser = createStreamingXmlParser(toolNames, { nonce: toolNonce });
      const turn = yield* this.#runWebTurn(
        turnPrompt, options, modelType, round === 0 ? images : [], parser, toolIndexState,
      );
      usage = addUsage(usage, turn.usage);
      rejections = turn.rejections;
      if (rejections.length === 0 || round + 1 >= maxTurns) break;
      // Correction round: tell the model exactly what was rejected, why, and
      // the only accepted form — then let it retry.
      turnPrompt = `${prompt}\n\n---\n\n${buildToolRetryFeedback(rejections, toolNames, toolNonce)}`;
    }

    if (usage !== null) yield { type: 'usage', usage };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  /**
   * One web completion round: pace, enqueue, map relay events to StreamChunks
   * (reasoning flows through; text accumulates and is parsed in phase 2 so
   * tool blocks are extracted and suppressed), and hand back the round's
   * usage plus any tool-block rejections for the correction round.
   */
  async *#runWebTurn(
    prompt: string,
    options: GenerateOptions,
    modelType: string,
    images: readonly RelayImage[],
    xmlParser: StreamingXmlParser,
    toolIndexState: { next: number },
  ): AsyncGenerator<StreamChunk, WebTurnOutcome> {
    // Pace every generation after the first (pp release pacing): the web
    // endpoint rate limits bursty traffic, and Throttle here keeps the
    // extension's web calls spaced apart without extra relay machinery.
    if (this.#requestCount > 0) {
      const delay = this.#requestDelayMinMs
        + Math.random() * (this.#requestDelayMaxMs - this.#requestDelayMinMs + 1);
      await sleep(delay, options.signal);
    }
    this.#requestCount += 1;

    const ticket = this.#enqueue({
      prompt,
      modelType,
      dshSessionId: options.sessionId,
      ...(images.length === 0 ? {} : { images: [...images] }),
    });

    let fullText = '';
    let pendingUsage: { inputTokens: number; outputTokens: number } | null = null;
    let sawFinish = false;

    // Cancellation must interrupt a PARKED wait too, so the queue iterator is
    // raced against the caller's abort signal instead of using plain for-await.
    let onAbort: (() => void) | null = null;
    const callerSignal = options.signal;
    const abortPromise = callerSignal === undefined
      ? new Promise<null>(() => undefined)
      : new Promise<null>((resolve) => {
          if (callerSignal.aborted) {
            resolve(null);
            return;
          }
          onAbort = () => resolve(null);
          callerSignal.addEventListener('abort', onAbort, { once: true });
        });

    const queueIterator = ticket[Symbol.asyncIterator]();

    try {
      while (!sawFinish) {
        if (options.signal?.aborted) return { usage: pendingUsage, rejections: xmlParser.rejections };

        const raced = await Promise.race([
          queueIterator.next().then((result) => ({ kind: 'event' as const, result })),
          abortPromise.then(() => ({ kind: 'aborted' as const })),
        ]);
        if (raced.kind === 'aborted') return { usage: pendingUsage, rejections: xmlParser.rejections };

        const { done, value: event } = raced.result;
        if (done || event === undefined) break;

        switch (event.t) {
          case 'reasoning':
            yield { type: 'reasoning-delta', index: REASONING_INDEX, text: event.delta };
            break;
          case 'text':
            fullText += event.delta;
            break;
          case 'usage':
            pendingUsage = {
              inputTokens: event.inputTokens ?? 0,
              outputTokens: event.outputTokens ?? 0,
            };
            break;
          case 'finish':
            sawFinish = true;
            break;
          case 'error':
            throw new LlmError(event.message, event.code);
        }
        // finish terminates the stream immediately — nothing after it is valid
        // (usage was already buffered; a trailing error is the queue closing).
        if (sawFinish) break;
      }

      // Phase 2: parse accumulated text — extract XML tool calls, emit clean
      // chunks. The web UI appends a trailing disclaimer to every reply; strip
      // it before parsing so it never rides into the last visible delta (or
      // the tail after a tool envelope) — same suffix strip as OmniRoute.
      const cleanText = fullText.replace(
        /\s*This response is AI-generated, for reference only\.\s*$/i,
        '',
      );
      const parsed = xmlParser.append(cleanText);
      const flushed = xmlParser.flush();

      for (const text of [...parsed.textDeltas, ...flushed.textDeltas]) {
        if (text) yield { type: 'text-delta', index: TEXT_INDEX, text } as StreamChunk;
      }
      for (const tool of [...parsed.tools, ...flushed.tools]) {
        const callIndex = toolIndexState.next++;
        const callId = `web_call_\${callIndex}`;
        yield { type: 'block-start', index: callIndex, blockType: 'tool-call' } as StreamChunk;
        yield {
          type: 'tool-call-delta', index: callIndex, id: callId,
          name: tool.name, argumentsDelta: tool.argsJson,
        } as StreamChunk;
        yield {
          type: 'block-end', index: callIndex,
          block: { type: 'tool-call', id: callId, name: tool.name, arguments: tool.argsJson },
        } as StreamChunk;
      }
    } finally {
      if (onAbort !== null && callerSignal !== undefined) {
        callerSignal.removeEventListener('abort', onAbort);
      }
    }

    if (!sawFinish) throw new LlmError('relay stream ended before finish', 'RELAY_INCOMPLETE');
    return { usage: pendingUsage, rejections: xmlParser.rejections };
  }
}

interface WebTurnOutcome {
  usage: { inputTokens: number; outputTokens: number } | null;
  rejections: readonly ToolRejection[];
}

function addUsage(
  a: { inputTokens: number; outputTokens: number } | null,
  b: { inputTokens: number; outputTokens: number } | null,
): { inputTokens: number; outputTokens: number } | null {
  if (a === null) return b;
  if (b === null) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** Model-facing label for one rejection reason. */
const REJECTION_LABEL: Record<ToolRejectionReason, string> = {
  BROKEN_JSON: 'the <tool> block body was not valid JSON',
  UNKNOWN_TOOL: 'the "name" field did not match any available tool',
  NONCE_MISMATCH: "the echoed \"_nonce\" did not match this request's binding",
  UNCLOSED_BLOCK: 'a tool-call block was never closed',
  OVERSIZE_BLOCK: 'a tool-call block exceeded the size limit without closing',
};

/**
 * Build the correction-round prompt appended after the original prompt:
 * rejected blocks with reasons, then the only accepted form restated
 * (nonce included) so the model can re-issue a valid call immediately.
 */
function buildToolRetryFeedback(
  rejections: readonly ToolRejection[],
  toolNames: ReadonlySet<string>,
  nonce: string | undefined,
): string {
  const lines: string[] = [];
  lines.push('[SYSTEM FEEDBACK — rejected tool call]');
  lines.push('Your previous reply contained tool-call block(s) that were rejected and NOT executed:');
  rejections.forEach((rejection, index) => {
    lines.push(`${index + 1}. ${REJECTION_LABEL[rejection.reason]} — ${rejection.detail}`);
  });
  lines.push('');
  lines.push('The ONLY accepted form (no markdown fence, in the final answer, never inside thinking):');
  lines.push(`<tool>{"name": "<tool_name>", "arguments": { ... }${nonce ? `, "_nonce": "${nonce}"` : ''}}</tool>`);
  lines.push('- The body must be ONE valid JSON object: double-quoted keys and strings, no trailing commas, no comments.');
  lines.push(`- "name" must be exactly one of: ${[...toolNames].join(', ')}.`);
  if (nonce !== undefined) lines.push(`- "_nonce" must be exactly "${nonce}".`);
  lines.push('Re-issue the corrected tool-call block now. If no tool call is actually needed, reply normally instead.');
  return lines.join('\n');
}

/**
 * Composes the full flat prompt sent to the DeepSeek web completion endpoint.
 * Unlike API-based providers, the web channel has a single `prompt` string —
 * so system prompt, tool instructions, and conversation history must all be
 * folded into one message.
 */
export function composeWebPrompt(options: GenerateOptions & { toolNonce?: string }): string {
  const sections: string[] = [];

  if (options.system) {
    sections.push(options.system);
  }

  if (options.tools && options.tools.length > 0) {
    sections.push(buildToolInstructions(options.tools, options.toolNonce));
  }

  const historyText = flattenHistory(options.messages);
  if (historyText) sections.push(historyText);

  return sections.join('\n\n---\n\n');
}

/**
 * Per-request tool-invocation binding. Embedded in the tool instructions and
 * checked inside every parsed `<tool>` block whose JSON body carries an
 * explicit `_nonce` — a mismatched nonce means the block is hallucinated or
 * copy-attacked, not a genuine call (mechanism after OmniRoute webTools.ts
 * #9343, MIT).
 */
export function createToolNonce(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * Serialize the tool catalog into the single canonical `<tool>` envelope
 * contract. One uniform shape (not per-tool tags) leaves the model fewer
 * wrapper formats to invent; the `_nonce` binding ties every parsed call to
 * THIS request so stray JSON from thinking or history is never promoted.
 */
function buildToolInstructions(tools: NonNullable<GenerateOptions['tools']>, nonce?: string): string {
  const parts: string[] = [];

  parts.push([
    '## Tools',
    '',
    'You can call tools. To call a tool, output ONLY this exact block (no markdown fence):',
    `<tool>{"name": "<tool_name>", "arguments": { ... }${nonce ? `, "_nonce": "${nonce}"` : ''}}</tool>`,
    'Rules:',
    '- Use exactly <tool>...</tool>. Do NOT use <tool:name>, <invoke name="...">,',
    '  <parameter>, id=/name= attributes, fullwidth ｜｜DSML｜｜ markers, or code fences.',
    '- The body MUST be a single valid JSON object on its own. Use forward slashes or',
    '  escaped backslashes for file paths.',
    `- "name" must be one of the tools below; "arguments" must be a JSON object.${nonce ? ` Include the secret binding "_nonce": "${nonce}" exactly as shown.` : ''}`,
    '- When a tool is needed, emit the <tool> block instead of only describing the plan.',
    '- Never place a tool block in a thinking/reasoning section; put it in the final',
    '  answer content so it can be executed.',
    '- Malformed call blocks (invalid JSON, unknown "name", wrong or missing "_nonce",',
    '  unclosed) are rejected and a correction round with the reasons will follow.',
    '- Do NOT say you cannot call listed tools — they are connected and ready.',
  ].join('\n'));

  for (const tool of tools) {
    let schemaText = '';
    try {
      const params = tool.parameters as Record<string, unknown> | undefined;
      if (params && nonce) {
        // Nonce-bound schema: _nonce becomes a const-required property, so the
        // model sees the binding as part of the contract it must satisfy.
        const properties = {
          ...((params.properties ?? {}) as Record<string, unknown>),
          _nonce: { type: 'string', const: nonce },
        };
        const baseRequired = Array.isArray(params.required)
          ? params.required.filter((r): r is string => typeof r === 'string')
          : [];
        schemaText = JSON.stringify({ ...params, properties, required: [...new Set([...baseRequired, '_nonce'])] });
      } else if (params) {
        schemaText = JSON.stringify(params);
      }
    } catch {
      schemaText = '';
    }

    parts.push([
      `### Tool ${tool.name}`,
      `Description: ${tool.description}`,
      schemaText ? `Parameters JSON Schema: ${schemaText}` : '(no parameters)',
    ].join('\n'));
  }

  // End-of-prompt reminder (pp pattern: reinforce right before user message).
  const names = tools.map(t => t.name).join(', ');
  parts.push([
    '---',
    '工具调用格式提醒：',
    `可用工具名：${names}`,
    '这些工具已连接，可以执行。不要声称自己无法调用列表中的工具。',
    '调用工具时，只能使用 <tool>{"name": ..., "arguments": ...}</tool> 这一种格式，',
    '不要使用 <invoke name="...">、全角｜｜DSML｜｜标记、<工具名> 标签或任何包装格式。',
    '不要把工具调用放在思考/reasoning 区域；必须放在最终回答正文中。',
  ].join('\n'));

  return parts.join('\n\n');
}

/** Flattens conversation history to readable text, newest-last. */
function flattenHistory(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const shaped = message as { role?: unknown; content?: unknown };
    const role = String(shaped.role ?? '').toLowerCase();
    const content = shaped.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          if (typeof block === 'string') return block;
          if (block !== null && typeof block === 'object' && (block as {type?:unknown}).type === 'text')
            return String((block as {text?:unknown}).text ?? '');
          return '';
        })
        .join('');
    }
    if (text) parts.push(`[${role}]: ${text}`);
    else if (role !== '') {
      // Non-text blocks (e.g. images) travel as refFileIds; leave a marker
      // so the prompt references what the model will actually receive.
      const names: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block !== null && typeof block === 'object' && (block as {type?:unknown}).type === 'image') {
            const ref = ((block as {attachment?:unknown}).attachment ?? block) as WebImageRef;
            names.push(String(ref.name ?? ref.attachmentId ?? 'image'));
          }
        }
      }
      if (names.length > 0) parts.push(`[${role}]: [attached images: ${names.join(', ')}]`);
    }
  }
  return parts.join('\n');
}

// In-process web completion consumer: when a model turn enqueues a relay
// ticket, this module immediately drives the real chat.deepseek.com completion
// and feeds reasoning/text events back to the ticket queue — so the "plugin
// only" deployment (no browser extension, no external relay-consumer process)
// works with just `dsh web` running. Mirrors scripts/relay-consumer.mjs and
// the extension background.ts session-chain logic, but consumes tickets
// in-memory instead of over the loopback HTTP endpoints.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createChatSession, createPowHeaders, submitPrompt, uploadDeepSeekFile } from './protocol/client.ts';
import { DEEPSEEK_WEB_ROUTES } from './protocol/routes.ts';
import type { RelayEvent, RelayImage } from './wire-events.ts';
import type { RelayHandle } from './relay-server.ts';

const DEFAULT_AUTH_FILE = '.dsh-auth.json';

/** Per-dsh-session web chain: one chat.deepseek.com conversation per dsh session. */
interface WebChain {
  chatSessionId: string | null;
  parentMessageId: number | null;
}

export interface WebCompletionOptions {
  /** Absolute path to the captured auth headers file (.dsh-auth.json). */
  authFile?: string;
  /** Absolute path to the PoW WASM bytes. */
  wasmPath?: string;
  /** Sink for diagnostics; defaults to stderr. */
  log?: (line: string) => void;
}

/**
 * Wire the relay to the real web session. Every enqueued ticket is consumed
 * immediately: create (or reuse) the web chat session, run the completion,
 * and deliver events back to the ticket's queue. Missing auth degrades to a
 * no-op (tickets stay parked) instead of failing the plugin boot.
 */
export function attachWebConsumer(relay: RelayHandle, options: WebCompletionOptions = {}): () => void {
  const log = options.log ?? ((line) => process.stderr.write(line + '\n'));
  const authFile = options.authFile ?? findAuthFile();
  const wasmPath = options.wasmPath ?? findWasmPath();

  if (authFile === null || !existsSync(authFile)) {
    log(`llm-deepseek-web: auth file not found (${authFile ?? 'looked in workspace root'}); ` +
      'web completions disabled — run dsh-web/scripts/capture-web-headers.mjs first.');
    return () => undefined;
  }

  const chains = new Map<string, WebChain>();

  function chainFor(dshSessionId: string | undefined): WebChain {
    const key = dshSessionId ?? 'default';
    let chain = chains.get(key);
    if (chain === undefined) {
      chain = { chatSessionId: null, parentMessageId: null };
      chains.set(key, chain);
    }
    return chain;
  }

  // Patch the relay: wrap enqueue so every new ticket gets a completion worker.
  const originalEnqueue = relay.enqueue.bind(relay);
  relay.enqueue = (request) => {
    const ticket = originalEnqueue(request);
    const chain = chainFor(request.dshSessionId);
    void runCompletion(ticket.id, request.prompt, request.images ?? [], chain, authFile, wasmPath, relay, log);
    return ticket;
  };

  return () => {
    // Restore original enqueue on dispose.
    relay.enqueue = originalEnqueue;
  };
}

/**
 * Retry policy mirroring deepseek-pp's automation scheduler
 * (AUTOMATION_MAX_ATTEMPTS / AUTOMATION_RETRY_DELAY_MS): at most 2 attempts
 * per turn, with a deliberate delay before the retry so a transient WAF
 * rejection (e.g. an occasional 40002) is not mistaken for an expired login.
 */
const WEB_MAX_ATTEMPTS = 2;
const WEB_RETRY_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCompletion(
  ticketId: number,
  prompt: string,
  images: RelayImage[],
  chain: WebChain,
  authFile: string,
  wasmPath: string,
  relay: RelayHandle,
  log: (line: string) => void,
): Promise<void> {
  const emit = (event: RelayEvent): void => relay.deliverEvent(ticketId, event);
  for (let attempt = 1; attempt <= WEB_MAX_ATTEMPTS; attempt++) {
    try {
      // Re-read auth on every attempt so a refreshed file is picked up.
      const auth = JSON.parse(readFileSync(authFile, 'utf8')) as { completionHeaders?: Record<string, string> };
      const headers = { ...(auth.completionHeaders ?? {}) };
      // Strip stale per-request PoW — dual values confuse the server (MISSING_HEADER).
      for (const key of Object.keys(headers)) {
        if (/pow/i.test(key)) delete headers[key];
      }

      if (chain.chatSessionId === null) {
        chain.chatSessionId = await createChatSession(headers);
      }

      let wasmBytes: Uint8Array | undefined;
      if (wasmPath !== '' && existsSync(wasmPath)) {
        wasmBytes = readFileSync(wasmPath);
      }
      // Upload attached images first (upload-bound PoW, then referenced by id).
      const refFileIds: string[] = [];
      for (const image of images) {
        const uploadPow = await createPowHeaders(
          headers,
          DEEPSEEK_WEB_ROUTES.uploadFile,
          wasmBytes === undefined ? undefined : { kind: 'bytes', bytes: wasmBytes },
        );
        const uploaded = await uploadDeepSeekFile({
          file: new Blob([Buffer.from(image.dataBase64, 'base64')], { type: image.mimeType }),
          filename: image.filename,
          modelType: 'default',
          clientHeaders: headers,
          powHeaders: uploadPow,
        });
        refFileIds.push(uploaded.id);
      }
      const powHeaders = await createPowHeaders(headers, undefined, wasmBytes === undefined ? undefined : { kind: 'bytes', bytes: wasmBytes });

      const turn = await submitPrompt(
        {
          chatSessionId: chain.chatSessionId,
          parentMessageId: chain.parentMessageId,
          modelType: 'default',
          prompt,
          refFileIds,
          thinkingEnabled: true,
          searchEnabled: false,
          clientHeaders: headers,
          powHeaders,
        },
        {
          onReasoningChunk: (r) => emit({ t: 'reasoning', delta: r }),
          onTextChunk: (t) => emit({ t: 'text', delta: t }),
        },
      );
      emit({ t: 'finish' });
      if (turn.responseMessageId !== null && turn.responseMessageId !== undefined) {
        chain.parentMessageId = turn.responseMessageId;
      }
      log(`llm-deepseek-web: turn ok (ticket ${ticketId}, session ${String(chain.chatSessionId).slice(0, 8)}…)`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < WEB_MAX_ATTEMPTS) {
        // Deliberate pp-style delay, then a fresh web session for the retry.
        log(`llm-deepseek-web: attempt ${attempt} failed (ticket ${ticketId}): ${message.slice(0, 160)} — retrying in ${WEB_RETRY_DELAY_MS / 1000}s…`);
        chain.chatSessionId = null;
        chain.parentMessageId = null;
        await sleep(WEB_RETRY_DELAY_MS);
        continue;
      }
      // Distinguish expired/invalid login (40002 Missing Token, 401) from
      // transient faults: the user must re-capture once — never silently retry.
      if (isAuthFailure(message)) {
        log(`llm-deepseek-web: WEB LOGIN EXPIRED (ticket ${ticketId}) — ${message.slice(0, 200)}`);
        log('llm-deepseek-web: re-capture the login: run `node dsh-web/scripts/capture-web-headers.mjs` '
          + '(or write ~/.dsh/web-auth.json) on any logged-in DeepSeek Web machine, then retry.');
        emit({ t: 'error', code: 'WEB_AUTH_EXPIRED', message });
        return;
      }
      log(`llm-deepseek-web: web completion error (ticket ${ticketId}): ${message}`);
      emit({ t: 'error', code: 'WEB_CONSUMER', message });
    }
  }
}

/** True when the error indicates the captured login is no longer accepted. */
function isAuthFailure(message: string): boolean {
  if (/40002|Missing Token|401|Unauthorized|auth token was rejected|login/i.test(message)) return true;
  return false;
}

/**
 * Locate the auth file for THIS machine/user. Resolution order:
 *   1. explicit config ({@link WebCompletionOptions.authFile})
 *   2. $DSH_WEB_AUTH_FILE (portable per-machine override)
 *   3. ~/.dsh/web-auth.json (standard per-user location — each machine's
 *      capture writes here, so any user can drive their own web session)
 *   4. workspace-root .dsh-auth.json (dev fallback)
 * Returns null when nothing exists (relay degrades to parked tickets).
 */
function findAuthFile(): string | null {
  const env = process.env.DSH_WEB_AUTH_FILE;
  if (env !== undefined && env !== '' && existsSync(env)) return env;

  const homeAuth = join(homedir(), '.dsh', 'web-auth.json');
  if (existsSync(homeAuth)) return homeAuth;

  // dist/index.js lives at dsh-web/adapter/dist — workspace root is ../../..
  const candidates = [
    new URL('../../../.dsh-auth.json', import.meta.url),
    new URL('./.dsh-auth.json', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = candidateToPath(candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Locate the PoW WASM: $DSH_WEB_WASM, adapter-bundled ../wasm, then dsh-web public. */
function findWasmPath(): string {
  const env = process.env.DSH_WEB_WASM;
  if (env !== undefined && env !== '' && existsSync(env)) return env;

  // dist/index.js sits beside wasm/ inside the installed package: ../wasm.
  const candidates = [
    new URL('../wasm/sha3_wasm_bg.wasm', import.meta.url),
    new URL('../../public/deepseek/sha3_wasm_bg.wasm', import.meta.url),
    new URL('../../../public/deepseek/sha3_wasm_bg.wasm', import.meta.url),
    new URL('./public/deepseek/sha3_wasm_bg.wasm', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = candidateToPath(candidate);
    if (existsSync(path)) return path;
  }
  return '';
}

/** Convert a file: URL to a filesystem path (windows-safe). */
function candidateToPath(url: URL): string {
  const { pathname } = url;
  if (process.platform === 'win32' && pathname.startsWith('/')) {
    return decodeURIComponent(pathname.slice(1));
  }
  return decodeURIComponent(pathname);
}

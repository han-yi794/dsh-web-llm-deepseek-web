import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import type { RetryPolicyConfig, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import { DeepSeekWebAdapter, type DeepSeekWebAdapterOptions } from './deepseek-web-adapter.ts';
import { startRelayServer } from './relay-server.ts';
import { attachWebConsumer } from './web-completion.ts';

export const name = 'llm-deepseek-web';
export const inject = ['llm'];

export interface Config {
  /** Loopback port the extension relay client polls. */
  port: number;
  /** Request pacing: random delay (ms) between consecutive web requests, after the first. */
  requestDelayMinMs: number;
  requestDelayMaxMs: number;
  /** Provider retry policy consumed by the official dsh-llm-retry plugin. */
  retryPolicy?: RetryPolicyConfig;
  /** Absolute path to the captured auth headers file (.dsh-auth.json). */
  authFile?: string;
  /** Absolute path to the PoW WASM bytes (sha3_wasm_bg.wasm). */
  wasmPath?: string;
  /** Disable the in-process web completion consumer (external relay consumer only). */
  disableEmbeddedConsumer?: boolean;
  /**
   * Refuse to hand relay tickets to HTTP pollers. Set when the embedded
   * consumer owns completions so a stale browser extension cannot race it
   * and poison turns with its own errors. E2E keeps this off because its
   * fake-extension poller needs the HTTP endpoints.
   */
  disableHttpRelay?: boolean;
}

export const Config: z<Config> = z.object({
  port: z.number().default(3117),
  requestDelayMinMs: z.number().default(2_500),
  requestDelayMaxMs: z.number().default(6_500),
  // z.object fields are optional unless `.required()`; RetryPolicySchema itself
  // selects normal-mode defaults when the field is omitted.
  retryPolicy: RetryPolicySchema,
  authFile: z.string(),
  wasmPath: z.string(),
  disableEmbeddedConsumer: z.boolean().default(false),
  disableHttpRelay: z.boolean().default(false),
});

export function apply(ctx: Context, config: Config): void {
  // The loopback relay lives and dies with the runtime process; the app bin's
  // explicit exits close the listening socket with it.
  const relay = startRelayServer({ port: config.port, disableHttpRelay: config.disableHttpRelay });

  // Plugin-only deployment: consume relay tickets in-process (no browser
  // extension, no external relay-consumer process). Missing auth degrades to
  // relay-only mode without failing boot.
  let detachConsumer: (() => void) | undefined;
  if (!config.disableEmbeddedConsumer) {
    detachConsumer = attachWebConsumer(relay, {
      authFile: config.authFile,
      wasmPath: config.wasmPath,
    });
    ctx.effect(() => () => detachConsumer?.(), 'llm-deepseek-web/consumer');
  }

  const options: DeepSeekWebAdapterOptions = {
    enqueue: (request) => relay.enqueue(request),
    requestDelayMinMs: config.requestDelayMinMs,
    requestDelayMaxMs: config.requestDelayMaxMs,
    // Same seam the official adapters use: resolve attached images to
    // readable paths per request (mirrors dsh-llm-deepseek wiring).
    resolveAttachments: () => ctx.get('attachments'),
    mapHostPath: (hostPath: string) => {
      const fs = ctx.get('fs') as {
        processPathFromHostPath?: (hostPath: string) => string | undefined;
      } | null | undefined;
      return fs?.processPathFromHostPath?.(hostPath);
    },
  };
  const resolvedRetry: ResolvedRetryPolicy | undefined = config.retryPolicy === undefined
    ? undefined
    : resolveRetryPolicy(config.retryPolicy, 'llm-deepseek-web: retryPolicy');

  ctx.llm.registerAdapter(['deepseek-web'], new DeepSeekWebAdapter(options, resolvedRetry));
}

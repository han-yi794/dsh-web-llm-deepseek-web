import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import type { RetryPolicyConfig, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import { DeepSeekWebAdapter, type DeepSeekWebAdapterOptions } from './deepseek-web-adapter.ts';
import { startRelayServer } from './relay-server.ts';

export const name = 'llm-deepseek-web';
export const inject = ['llm'];

export interface Config {
  /** Loopback port the extension's relay client polls. */
  port: number;
  /** Request pacing: random delay (ms) between consecutive web requests, after the first. */
  requestDelayMinMs: number;
  requestDelayMaxMs: number;
  /** Provider retry policy consumed by the official dsh-llm-retry plugin. */
  retryPolicy?: RetryPolicyConfig;
}

export const Config: z<Config> = z.object({
  port: z.number().default(3117),
  requestDelayMinMs: z.number().default(2_500),
  requestDelayMaxMs: z.number().default(6_500),
  // z.object fields are optional unless `.required()`; RetryPolicySchema itself
  // selects normal-mode defaults when the field is omitted.
  retryPolicy: RetryPolicySchema,
});

export function apply(ctx: Context, config: Config): void {
  // The loopback relay lives and dies with the runtime process; the app bin's
  // explicit exits close the listening socket with it.
  const relay = startRelayServer({ port: config.port });

  const options: DeepSeekWebAdapterOptions = {
    enqueue: (request) => relay.enqueue(request),
    requestDelayMinMs: config.requestDelayMinMs,
    requestDelayMaxMs: config.requestDelayMaxMs,
  };
  const resolvedRetry: ResolvedRetryPolicy | undefined = config.retryPolicy === undefined
    ? undefined
    : resolveRetryPolicy(config.retryPolicy, 'llm-deepseek-web: retryPolicy');

  ctx.llm.registerAdapter(['deepseek-web'], new DeepSeekWebAdapter(options, resolvedRetry));
}

// Ported from deepseek-pp `core/types.ts` (SSEEvent) and `core/deepseek/*`.
// https://github.com/zhu1090093659/deepseek-pp @ 0a02c72b135bf2936e11aa78fd6136931ed65908
// Upstream is Apache-2.0 — see NOTICE.md in this repository.

/** One parsed Server-Sent Event frame of a DeepSeek web completion stream. */
export interface SSEEvent {
  id?: string;
  type: string;
  data: string;
}

NOTICE
======

This package includes code ported from DeepSeek++ (deepseek-pp)

  https://github.com/zhu1090093659/deepseek-pp

Copyright (c) the deepseek-pp authors, licensed under the Apache License,
Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).

Ported sources (carrying their own upstream headers):

  - `src/xml-stream-parser.ts` — patterns from deepseek-pp
    `core/interceptor/streaming-tool-call-parser.ts` (linear-time tag scanning;
    artifact externalization machinery not shipped).
  - `src/xml-tools.ts` — ported from deepseek-pp `core/tool/xml-tags.ts`.

Upstream commit: 0a02c72b135bf2936e11aa78fd6136931ed65908 (2026-08-14).

The package interfaces with DeepSeek Harness
(https://github.com/deepseek-ai/deepseek-harness, MIT) through its public
plugin API; it does not include or fork harness internals.

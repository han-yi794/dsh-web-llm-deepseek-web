NOTICE
======

本包包含从 DeepSeek++(deepseek-pp)移植的代码

  https://github.com/zhu1090093659/deepseek-pp

版权所有 (c) deepseek-pp 作者,依据 Apache License, Version 2.0 许可
(http://www.apache.org/licenses/LICENSE-2.0)。

移植的源文件(各自带有上游文件头声明):

  - `src/xml-stream-parser.ts` — 源自 deepseek-pp
    `core/interceptor/streaming-tool-call-parser.ts`(线性时间标签扫描;
    不包含未随附的产物外部化机制)。
  - `src/xml-tools.ts` — 移植自 deepseek-pp `core/tool/xml-tags.ts`。

上游提交:0a02c72b135bf2936e11aa78fd6136931ed65908 (2026-08-14)。

本包通过其公共插件 API 与 DeepSeek Harness
(https://github.com/deepseek-ai/deepseek-harness,MIT) 对接;
不包含也不派生 harness 内部实现。

---

## English Summary

This package includes code ported from DeepSeek++ (deepseek-pp), licensed
under Apache-2.0. See the Chinese sections above for the exact attribution and
upstream commit. The package interfaces with DeepSeek Harness (MIT) through its
public plugin API only.

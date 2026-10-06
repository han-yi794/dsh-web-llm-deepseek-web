# src/protocol — vendored web-protocol snapshot

This directory is a **vendored snapshot** of the DeepSeek web protocol layer
from the `dsh-web` workspace (`dsh-web/core/deepseek/`, itself ported from
[DeepSeek++](https://github.com/zhu1090093659/deepseek-pp), Apache-2.0 —
see [`../NOTICE.md`](../NOTICE.md)).

## Why vendored, not referenced

This package must build standalone from a plain `git clone`
(`node scripts/build.mjs` inlines every relative import into `dist/`).
Referencing `../../core/deepseek/` would tie the build to the sibling
`dsh-web` checkout, so the protocol travels with the package instead.

## Sync rule

`dsh-web/core/deepseek/` remains the development authority. When it changes,
re-copy its `*.ts` files here verbatim, rebuild, and verify:

```bash
node scripts/build.mjs   # esbuild bundle → dist/index.js
```

Do not diverge the two copies: any behavioral fix belongs upstream first
(`dsh-web/core/deepseek/`), then re-vendored here.

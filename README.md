# @dsh-web/llm-deepseek-web

dsh plugin: **DeepSeek WEB-session LLM adapter** — drives the free
[chat.deepseek.com](https://chat.deepseek.com) session as a model provider
inside the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Instead of an API key, the adapter relays model calls to the logged-in web
session. The browser companion extension (`dsh-web` project) captures the
session's verbatim request headers and bridges them into the dsh runtime, so
the free web subscription becomes a usable harness model route.

## Features

- Two model modes over one provider route:
  - `deepseek-expert` — 深度推理（专家）模式
  - `deepseek-vision` — 识图模式
- Full dsh ecosystem compatibility: ships as a Cordis bundle patch, mounts
  alongside the official `deepseek-official` / `pi-ai` routes.
- Per-(dsh session, mode) web conversation chain isolation — sessions never
  share chat.deepseek.com context.
- Global request gate (pp-style anti-burst): every DeepSeek web request is
  spaced by a minimum interval so agent runs and concurrent sessions don't
  hammer chat.deepseek.com.
- Provider retry policy exposed to the official `dsh-llm-retry` plugin
  (`RATE_LIMIT` on 429).

## Installation

```bash
npm install @dsh-web/llm-deepseek-web
```

Register the bundle in the profile's `package.json` (or `cordis.yml`):

```jsonc
{
  "dependencies": {
    "@dsh-web/llm-deepseek-web": "^0.1.1-rc.2"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-web/llm-deepseek-web",
        // ...other bundles
      ]
    }
  }
}
```

## Usage

1. Start dsh with the web profile (`dsh web`).
2. Open `http://127.0.0.1:3080`, create a session, select
   `deepseek-web` / `deepseek-expert` (or `deepseek-vision`).
3. The web session login is provided by the companion browser extension; a
   logged-in chat.deepseek.com tab is required for generation.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `port` | `3117` | Loopback port the extension's relay polls |
| `requestDelayMinMs` | `2500` | Min pacing between generations (after the first) |
| `requestDelayMaxMs` | `6500` | Max pacing between generations (after the first) |
| `retryPolicy` | normal defaults | Provider retry policy (consumed by `dsh-llm-retry`) |

The global per-request gate (default 2500 ms) can be overridden at runtime via
`setDeepSeekRequestMinInterval()`.

## License

Apache-2.0. Includes code ported from
[DeepSeek++](https://github.com/zhu1090093659/deepseek-pp) — see
[NOTICE.md](./NOTICE.md). Interfaces with DeepSeek Harness (MIT) through its
public plugin API.

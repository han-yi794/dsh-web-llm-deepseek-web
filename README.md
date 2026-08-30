# @dsh-web/llm-deepseek-web

**dsh 插件:DeepSeek 网页会话 LLM 适配器**

将免费的 [chat.deepseek.com](https://chat.deepseek.com) 网页登录会话,作为
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)
的一个模型供应商来驱动。

与需要 API Key 不同,本适配器把模型调用中继到已登录的网页会话。配套的
浏览器扩展(`dsh-web` 项目)捕获会话的逐字请求头,并桥接进 dsh 运行时,让
免费网页订阅成为可用的 harness 模型路由。

## 功能特性

- 单一供应商路由下提供两种模型模式:
  - `deepseek-expert` — 深度推理(专家)模式
  - `deepseek-vision` — 识图模式
- 完整的 dsh 生态兼容:以 Cordis bundle patch 形式分发,与官方
  `deepseek-official` / `pi-ai` 路由并列挂载,互不覆盖。
- **按(dsh 会话, 模式)隔离网页对话链** — 不同 dsh 会话绝不共享
  chat.deepseek.com 上下文。
- **全局请求门控**(仿 pp 防突发):每个 DeepSeek 网页请求至少间隔最小
  时间,避免 agent 运行与并发会话对 chat.deepseek.com 造成请求风暴。
- 向官方 `dsh-llm-retry` 插件暴露供应商重试策略(429 时上报 `RATE_LIMIT`)。

## 安装

```bash
npm install @dsh-web/llm-deepseek-web
```

在 profile 的 `package.json`(或 `cordis.yml`)中注册 bundle:

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
        // ...其他 bundle
      ]
    }
  }
}
```

## 使用方法

1. 用 web profile 启动 dsh:`dsh web`
2. 打开 `http://127.0.0.1:3080`,创建会话,选择
   `deepseek-web` / `deepseek-expert`(或 `deepseek-vision`)。
3. 网页登录态由配套浏览器扩展提供;生成前需要一个已登录的
   chat.deepseek.com 标签页。

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `port` | `3117` | 扩展 relay 轮询的回环端口 |
| `requestDelayMinMs` | `2500` | 生成之间的最小节奏(首个之后) |
| `requestDelayMaxMs` | `6500` | 生成之间的最大节奏(首个之后) |
| `retryPolicy` | 常规默认 | 供应商重试策略(由 `dsh-llm-retry` 消费) |

全局每请求门控(默认 2500 ms)可在运行时通过
`setDeepSeekRequestMinInterval()` 覆盖。

## 许可证

Apache-2.0。包含从
[DeepSeek++](https://github.com/zhu1090093659/deepseek-pp) 移植的代码 ——
参见 [NOTICE.md](./NOTICE.md)。通过其公共插件 API 与 DeepSeek Harness
(MIT) 对接。

---

## English Summary

`@dsh-web/llm-deepseek-web` is a dsh plugin that drives the free
chat.deepseek.com web session as a model provider. See the Chinese sections
above for features, installation, usage, and configuration. Licensed under
Apache-2.0; see [NOTICE.md](./NOTICE.md) for deepseek-pp attribution.

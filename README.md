# @dsh-web/llm-deepseek-web

**dsh 插件:DeepSeek 网页会话 LLM 适配器**

将免费的 [chat.deepseek.com](https://chat.deepseek.com) 网页登录会话,作为
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)
的一个模型供应商来驱动。

与需要 API Key 不同,本适配器把模型调用中继到已登录的网页会话。插件内置
网页完成消费者:加载即自动消费 relay ticket 并驱动真实
chat.deepseek.com 会话,**纯插件部署无需浏览器扩展、无需外部常驻进程**,
`dsh web` 一条命令即可用,免费网页订阅成为可用的 harness 模型路由。

## 功能特性

- 单一模型入口 `deepseek-web`(网页会话,内置视觉;wire model_type 统一
  `default`)——chat.deepseek.com 本来就是单一模型入口,不再分子模式。
- 完整的 dsh 生态兼容:以 Cordis bundle patch 形式分发,与官方
  `deepseek-official` / `pi-ai` 路由并列挂载,互不覆盖。
- **按 dsh 会话 1:1 隔离网页对话链** — 每个 dsh 会话绑定唯一的
  chat.deepseek.com 会话(parent 链延续),不同 dsh 会话绝不共享上下文。
- **内嵌网页完成消费者**(插件独占模式) — 插件加载即在进程内消费 relay
  ticket,无需浏览器扩展、无需外部 `relay-consumer` 进程;旧扩展若仍在轮询,
  用 `disableHttpRelay: true` 让 HTTP 取票口直接回 204,使其抢不到单。
- **pp 式重试与故意延迟** — 每轮最多 2 次,失败故意等待 10 秒再试(仿
  deepseek-pp `AUTOMATION_MAX_ATTEMPTS` / `AUTOMATION_RETRY_DELAY_MS`);重试前
  重读凭据文件并重开网页会话。偶发 40002 只会多等 10 秒,两次都 40002/401
  才报 `WEB_AUTH_EXPIRED` 并提示重抓登录。
- **全局请求门控**(仿 pp 防突发):每个 DeepSeek 网页请求至少间隔最小
  时间,避免 agent 运行与并发会话对 chat.deepseek.com 造成请求风暴。
- 向官方 `dsh-llm-retry` 插件暴露供应商重试策略(429 时上报 `RATE_LIMIT`)。
- **思考过程同步** — 网页 THINK 片段经 `reasoning` 事件 → `reasoning-delta`
  组装为 `reasoning` 消息块,官方 UI 原生渲染。
- **图片发送(视觉)** — 模型目录声明 `inputModalities: ["text", "image"]`;
  消息里的图片块经附件存储解析为字节,上传到网页文件接口后以 `refFileIds`
  引用,网页模型真实"看见"图片内容(已真图验证)。
- **工具调用双格式容忍** — 标准 `<toolname>{json}</toolname>` 与网页模型偶发的
  全角 DSML 包裹格式(`<｜｜DSML｜｜ calls>→invoke→parameter`)都会被识别并
  执行,未知工具名静默丢弃,原文永不泄漏到回答中(含分片跨 chunk 场景)。

## 安装

```bash
npm install @dsh-web/llm-deepseek-web
```

本包开箱自包含:网页协议层以快照形式收录在 `src/protocol/`
(源自 `dsh-web` 工作区的 `core/deepseek`,见该目录 `README.md` 的同步规则),
`node scripts/build.mjs` 把全部相对导入内联进 `dist/index.js`,
clone 下来即可构建,无需兄弟目录。

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

兼容的 dsh 发布线见 `package.json` 的 `peerDependencies`
(0.1.1-rc.2 / 0.2.0-rc.2 / 0.1.5-rc.2 / 0.1.7-rc.1 / 0.2.1-alpha.1 均已实测;
`dsh --profile web --dump-config` 可确认插件树正确挂载)。

## 使用方法

1. 在任一登录了 chat.deepseek.com 的电脑上抓一次登录凭据(见下节
   “跨电脑与多账号”),得到凭据文件。
2. 用 web profile 启动 dsh:`dsh web`
3. 打开 `http://127.0.0.1:3080`,创建会话,选择模型 `DeepSeek Web`。
4. 发消息即走网页会话真实回复;插件自动消费,无需其他进程。

直接在输入框点"添加文件"贴图即可,图片自动上传并随本轮一起发给网页模型。

## 跨电脑与多账号

凭据即文件,自动发现顺序如下(前者优先):

1. 插件配置 `authFile` 显式路径;
2. 环境变量 `$DSH_WEB_AUTH_FILE`;
3. **`~/.dsh/web-auth.json`** — 每台电脑/每个账号的标准位置;
4. 工作区根 `.dsh-auth.json`(开发回退)。

在某台电脑上登录任意账号后运行抓取脚本,即生成该机器该账号的凭据,
adapter 自动使用,互不干扰:

```bash
node dsh-web/scripts/capture-web-headers.mjs  # dsh-web 工作区内的脚本;写入工作区与 ~/.dsh/web-auth.json
```

凭据有效期为月级;失效时(40002/401)插件报 `WEB_AUTH_EXPIRED` 并提示重抓,
两次尝试都失败才会报错,偶发拒绝只会多等 10 秒。

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `port` | `3117` | 扩展 relay 轮询的回环端口 |
| `requestDelayMinMs` | `2500` | 生成之间的最小节奏(首个之后) |
| `requestDelayMaxMs` | `6500` | 生成之间的最大节奏(首个之后) |
| `retryPolicy` | 常规默认 | 供应商重试策略(由 `dsh-llm-retry` 消费) |
| `authFile` | 自动发现 | 抓取到的登录凭据文件绝对路径(见上节顺序) |
| `wasmPath` | 包内优先 | PoW WASM 绝对路径;默认用包内 `wasm/` |
| `disableEmbeddedConsumer` | `false` | 置 true 则只提供 relay,不内嵌消费(外部消费者模式) |
| `disableHttpRelay` | `false` | 置 true 则 HTTP 取票口一律回 204(内嵌消费独占,防旧扩展抢单;E2E 保持关闭) |

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
chat.deepseek.com web session as a model provider. It embeds its own web
completion consumer, so a plugin-only deployment needs no browser extension:
per-user login is auto-discovered (`~/.dsh/web-auth.json`), web THINK
fragments stream as reasoning blocks, attached images upload and ride as
`refFileIds`, both standard and fullwidth-DSML tool-call formats execute
without leaking, and failed turns retry pp-style before
reporting `WEB_AUTH_EXPIRED`. See the Chinese sections
above for features, installation, usage, and configuration. Licensed under
Apache-2.0; see [NOTICE.md](./NOTICE.md) for deepseek-pp attribution.

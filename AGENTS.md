# AGENTS.md

DeepSeek Harness（DSH）插件：`dsh-plugin-wecom-bot`，通过企业微信「智能机器人」长连接收发消息，
把私聊/群聊消息作为任务下发给 DSH agent 执行，并把结果回传到企业微信。

## 项目概况

- **包名**：`dsh-plugin-wecom-bot`（`"type": "module"`，ESM）
- **运行时依赖**：仅 `ws`（外加 `@deepseek-ai/*` 系列 dsh 运行时包与 `schemastery`）
- **安装方式**：插件自带 `node_modules`，通过 `dsh plugin --profile web add .` 装入 web profile（link 方式）
- **测试**：`npm test`（`node --test test/`，无外部依赖，FakeSocket 回放协议帧）
- **许可证**：MIT

## 代码结构

```
lib/wecom.js     # 协议纯函数：帧构建/解析、消息提取、@提及剥离、字节分块、事件汇总
lib/client.js    # 长连接客户端：订阅/心跳/重连/应答，socket 工厂可注入（便于测试）
lib/commands.js  # 工作区命令层：命令解析、目标目录解析、列表格式化（纯函数可单测）
lib/index.js     # Cordis 插件入口：配置 schema、agent 任务调度、消息流、工作区命令集成
test/            # node:test 单测（wecom.test.mjs / commands.test.mjs / session.test.mjs）
```

## 开发约定

- 保持**协议层为纯函数**（`lib/wecom.js`），网络与副作用集中在 `lib/client.js`，
  新增协议逻辑同步补 `test/wecom.test.mjs` 用例。
- 命令层（`lib/commands.js`）保持无 IO 的纯函数，新命令在 `test/commands.test.mjs` 覆盖解析与边界用例。
- 修改 `lib/index.js` 的会话/调度逻辑后，用 `npm test` 全量回归。
- 错误提示与注释使用中文，与现有代码一致。

## 关键约束（改动前必读）

- **必须带 ALPN 握手**：企业微信网关要求 TLS ClientHello 携带 ALPN `http/1.1`，
  Node 内置 WebSocket（undici）与 `http.request` 默认都不带，会被网关 400 拒绝。
  因此建连必须走 `ws` 库 + 显式 ALPN 的 `https.Agent`，**不要**换成 undici 或其他不带 ALPN 的客户端。
- **同一机器人仅允许一个长连接**：另一处连上时本连接会收到 `disconnected_event` 并被断开。
- 配置凭证来自环境变量 `WECOM_BOT_ID` / `WECOM_BOT_SECRET`（或 profile patch 覆盖），
  **不要把真实凭证写进代码或提交进 git**。
- 消息频率受企业微信限制（约 30 条/分钟）；图片/文件消息暂不处理。

## 常用命令

```sh
npm test                     # 跑全部单测
pnpm install                 # 安装插件自身依赖（link 安装要求自带 node_modules）
dsh plugin --profile web add .   # 装入 web profile，重启 dsh web 生效
```

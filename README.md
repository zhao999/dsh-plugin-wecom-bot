# dsh-plugin-wecom-bot

DeepSeek Harness（DSH）插件：通过企业微信「智能机器人」**长连接**收发消息，
把发给机器人的文本当作任务下发给 DSH agent 执行，并把结果回传到企业微信。

- **零公网依赖**：长连接模式由插件主动连出到企业微信网关（WebSocket），
  不需要公网 URL、不需要消息加解密、不需要可信 IP 白名单。
- **仅一个运行时依赖**（`ws`）：Node 内置 WebSocket 不带 ALPN 扩展，
  会被企业微信网关 400 拒绝（详见「常见问题」），因此使用 `ws` 库。
- 支持**私聊**与**群聊 @机器人**，多轮上下文（per-user 会话）或一次性任务（per-message）。

## 工作原理

```
企业微信成员 ──私聊/群聊──▶ 智能机器人 ──wss://openws.work.weixin.qq.com──▶ 本插件
                                                                             │
         ◀── aibot_respond_msg（stream 流式回复）◀── agent 任务结果 ─────────┤
                                                                             ▼
                                                              DSH agents.create → followup
                                                              → whenIdle → 汇总文本
```

协议实现基于官方文档
[《智能机器人长连接》](https://developer.work.weixin.qq.com/document/path/101463)，
并与 [cc-connect](https://github.com/chenhg5/cc-connect)、
[CowAgent](https://github.com/zhayujie/CowAgent) 两个开源实现交叉验证。

## 一、企业微信后台：创建智能机器人

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)。
2. 进入 **应用管理 → 智能机器人 → 创建智能机器人**。
3. 填写名称、头像等信息，创建完成后记录两个凭证：

   ```
   BotID:  xxxxxxxxxxxxxxxx
   Secret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

   > ⚠️ **Secret 只显示一次**，请立即保存。

4. 把机器人添加到会话：创建后在企业微信 App 里搜索该机器人，即可直接**私聊**；
   也可以把它拉进群聊，群成员 `@机器人` 发任务。

## 二、安装插件

在插件源码目录（本目录）执行：

```sh
# 1. 先装插件自身的依赖（link: 安装方式要求插件自带 node_modules）
pnpm install

# 2. 装进 web profile
dsh plugin --profile web add .
```

这会用 pnpm 把插件装进 `~/.dsh/profiles/web`，并把 `dsh-plugin-wecom-bot`
追加到该 profile 的 `dsh.profile.bundles`（bundle 层）。重启 `dsh web` 生效。

> 本机没有 pnpm 时可用 corepack 启用，或在工作区内安装：
> `npm install --prefix .tools/pnpm pnpm --cache .npm-cache`，
> 然后把 `.tools/pnpm/node_modules/.bin` 加入 PATH。

## 三、配置凭证

两种方式任选其一：

**方式 A：环境变量（默认，推荐）**

```sh
export WECOM_BOT_ID="wwxxxxxxxxxxxxxx"
export WECOM_BOT_SECRET="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
dsh web
```

**方式 B：profile patch 覆盖**（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: wecom-bot
  config:
    botId: wwxxxxxxxxxxxxxx
    botSecret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> patch 覆盖的是整行 `config`，覆盖时如需保留其他选项要一并写全
> （完整选项见下表）。

未配置时插件保持空闲、仅打印提示，不影响 `dsh web` 启动。

## 四、启动验证

```sh
dsh web
```

日志里应出现：

```
wecom-bot: connecting
wecom-bot: subscribed
wecom-bot: connected
```

然后在企业微信里私聊机器人发一条消息，例如：

```
帮我总结一下这个目录下 README.md 的主要内容
```

机器人先回复「✅ 已收到任务，agent 处理中…」，agent 跑完后回传最终结果。

## 五、bot 工作区命令

企业微信里给机器人发以下命令可以**查看/切换工作区**（决定 agent 在哪个
目录干活；每个企业微信成员独立记住自己的目录，多轮会话有效）：

| 命令 | 作用 |
|---|---|
| `查看工作区` / `#ws` / `#工作区` | 列出全部已注册工作区 + 当前目录 |
| `切换工作区 <名称或路径>` / `#ws <名称或路径>` | 切换到指定工作区（按标题或绝对/相对路径），下一条消息在新目录执行 |
| `#cwd` / `查看目录` | 显示当前工作目录 |
| `#cwd <路径>` | 直接设置工作目录 |

示例：

```
查看工作区
#ws productv4-web
切换工作区 /Users/zhaohanghang/work/java/bp_product_web
#cwd /Users/zhaohanghang/work/java/plug
```

说明：
- 切换命令会**持久化销毁旧目录的 agent 会话**，下一条任务用新目录重建
  agent（旧会话结果已 flush 保存）。
- 路径不存在/不是目录会返回错误提示；按标题匹配到多个工作区时需用完整路径。
- 需要 `sessionMode: per-user`（默认值）才支持切换；`per-message` 模式下
  每条消息都新建 agent，切换不持久。

## 六、权限审批（企业微信内完成）

agent 执行需要**权限提升**的操作（如沙箱升级、写敏感区域）时，DSH 会发起
审批。本插件把审批请求**转发到企业微信**，你在聊天里直接回复即可，无需
打开网页：

```
🔐 需要审批 #1
工具：execute_command
原因：命令需要提升权限以完成操作

回复「同意 #1」批准，或「拒绝 #1」拒绝
（也可直接回复 同意 / 拒绝，匹配你最近一条审批）
```

- 审批推送对象：**发起任务的成员**（私聊直接回，群聊里只有发起者回复才有效）。
- 回复支持：`同意 / 批准 / 允许 / 是 / ok / y`（批准），
  `拒绝 / 不同意 / 否 / no / n`（拒绝）；可带编号 `#1` 精确定位多条审批。
- 不回复时 agent 任务会**保持挂起**等待；可用 `approvalTimeoutMs` 配置超时
  （超时按拒绝处理）。
- 非 bot 创建的 agent（如 Web GUI 会话）的审批仍走网页审批，互不影响。

## 七、配置项

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `botId` | 环境变量 `WECOM_BOT_ID` | 智能机器人 BotID |
| `botSecret` | 环境变量 `WECOM_BOT_SECRET` | 智能机器人 Secret |
| `wsEndpoint` | `wss://openws.work.weixin.qq.com` | 长连接网关 |
| `heartbeatIntervalMs` | `30000` | 心跳间隔（毫秒） |
| `reconnectBaseDelayMs` | `1000` | 重连初始退避（毫秒） |
| `reconnectMaxDelayMs` | `30000` | 重连最大退避（毫秒） |
| `sessionMode` | `per-user` | `per-user` 每个成员一个 agent 会话（多轮上下文）；`per-message` 每条消息新建 agent |
| `cwd` | 进程 cwd | agent 的工作目录 |
| `provider` / `model` | 默认模型选择 | 覆盖 agent 使用的模型（留空用 `agentDefaultModel`） |
| `reasoningEffort` | 默认 | 推理档位（如 `high`/`medium`/`low`） |
| `agentPreset` | 部署默认（`standard`） | agent 装配预设：决定工具/提示。留空用部署默认（web profile 为 `standard`，含 bash/fs 等完整工具）；可选 `code` / `minimal`。**缺失 preset 时 agent 无工具，任务会"假执行"（模型输出伪工具调用文本）** |
| `ignoreOlderThanSec` | `300` | 忽略超过该秒数的历史消息（重连补发防抖） |
| `maxReplyChars` | `6000` | 最终回复最大字符数，超出截断 |
| `ackOnReceive` | `true` | 先推一条「已收到」中间态 |
| `stripGroupMentions` | `true` | 群聊消息去掉 `@机器人` 提及前缀 |
| `approvalTimeoutMs` | `0` | 审批超时（毫秒），0=不超时（agent 保持挂起等回复）；超时按拒绝处理 |

## 八、开发与测试

```sh
npm test        # node --test，跑协议/客户端/命令层单测
```

代码结构：

```
lib/wecom.js     # 协议纯函数：帧构建/解析、消息提取、@提及剥离、字节分块、事件汇总
lib/client.js    # 长连接客户端：订阅/心跳/重连/应答，socket 工厂可注入
lib/commands.js  # 工作区命令层：命令解析、目标目录解析、列表格式化（纯函数可单测）
lib/index.js     # Cordis 插件：配置 schema、agent 任务调度、消息流、工作区命令集成
test/            # node:test 单测（FakeSocket 回放协议帧 + 命令解析用例）
```

## 九、已知限制

- **必须带 ALPN 握手（已处理）**：企业微信长连接网关要求 TLS ClientHello
  携带 ALPN `http/1.1`，Node 内置 WebSocket（undici）与 `http.request` 默认
  都不带，握手会被网关以 400 拒绝。本插件用 `ws` 库 + 显式 ALPN 的
  `https.Agent` 建连解决；若改用其他客户端，请注意同样的问题。
- 同一机器人同时只允许一个长连接：另一处连上时本连接会收到
  `disconnected_event` 并被网关断开。
- 消息频率受企业微信限制（约 30 条/分钟）。
- 语音消息按转写文本处理；图片/文件消息暂不处理（会被忽略）。
- 最终回复超过 `maxReplyChars` 会被截断。

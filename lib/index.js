/**
 * dsh-plugin-wecom-bot 主插件。
 *
 * 通过企业微信「智能机器人」长连接（WebSocket）收发消息：私聊/群聊里发给
 * 机器人的文本会被当作任务下发给 DSH agent（复用 dsh-headless 的直接驱动
 * 模式：agents.create → followup → whenIdle → 汇总），处理结果通过
 * aibot_respond_msg 的 stream 流式回复回传到企业微信。
 *
 * 依赖服务：agents / sessions / agentDefaultModel（均为 dsh-base 行）。
 * 不依赖 webServer —— 长连接模式由本插件主动连出，无需公网回调地址。
 *
 * @module dsh-plugin-wecom-bot
 */
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { WecomClient } from "./client.js";
import { formatWorkspaceList, parseCommand, resolveTargetDir } from "./commands.js";
import {
  DEFAULT_WS_ENDPOINT,
  chunkByBytes,
  extractMessage,
  nextReqId,
  stripMentions,
  summarizeEvents,
} from "./wecom.js";

/** 稳定插件名（bundle patch 里按 id=wecom-bot 引用）。 */
const name = "wecom-bot";

/** 插件配置。botId/botSecret 留空时插件保持空闲并给出日志提示。 */
const Config = z.object({
  /** 企业微信智能机器人 BotID。 */
  botId: z.string().default(""),
  /** 企业微信智能机器人 Secret（创建时只显示一次）。 */
  botSecret: z.string().default(""),
  /** 长连接网关地址。 */
  wsEndpoint: z.string().default(DEFAULT_WS_ENDPOINT),
  /** 心跳间隔（毫秒）。 */
  heartbeatIntervalMs: z.natural().default(30_000),
  /** 重连初始退避（毫秒）。 */
  reconnectBaseDelayMs: z.natural().default(1_000),
  /** 重连最大退避（毫秒）。 */
  reconnectMaxDelayMs: z.natural().default(30_000),
  /**
   * 会话模式：per-user 为每个企业微信成员保留一个 agent 会话（多轮上下文），
   * per-message 每条消息新建一个 agent 会话（一次性任务）。
   */
  sessionMode: z.union([z.const("per-user"), z.const("per-message")]).default("per-user"),
  /** agent 的工作目录，缺省为当前进程 cwd。 */
  cwd: z.string().default(""),
  /** 覆盖默认模型提供方；留空用 agentDefaultModel 的当前选择。 */
  provider: z.string().default(""),
  /** 覆盖默认模型名；留空用 agentDefaultModel 的当前选择。 */
  model: z.string().default(""),
  /** 覆盖推理档位（high/medium/low 等）；留空用默认。 */
  reasoningEffort: z.string().default(""),
  /** 忽略超过该秒数的历史消息（重连后网关可能补发）。 */
  ignoreOlderThanSec: z.natural().default(300),
  /** 最终回复最大字符数，超出截断并提示。 */
  maxReplyChars: z.natural().default(6000),
  /** 收到任务先推一条「已收到」的中间态 stream。 */
  ackOnReceive: z.boolean().default(true),
  /** 群聊消息去掉 @机器人 提及前缀。 */
  stripGroupMentions: z.boolean().default(true),
});

/**
 * 汇总一次 agent 任务的结果文本；出错时抛错。
 */
function resolveOutcome(events, firstSeq) {
  const outcome = summarizeEvents(events, firstSeq);
  if (outcome.reason?.kind === "error") {
    throw new Error(`${outcome.reason.error.code}: ${outcome.reason.error.message}`);
  }
  return outcome.text;
}

/**
 * 一个企业微信成员对应的 agent 会话（per-user 模式）。
 * 串行执行该成员的任务，避免并发 followup 同一 agent。
 */
class UserSession {
  constructor(ctx, config, key) {
    this.ctx = ctx;
    this.config = config;
    this.key = key;
    /** 该会话当前的工作目录；切换命令会更新它并重建 agent。 */
    this.cwd = config.cwd || process.cwd();
    this.handle = null;
    this.tail = Promise.resolve();
  }

  /** 惰性创建 agent（复用 dsh-headless 的装配方式），cwd 取当前值。 */
  async ensureAgent() {
    if (this.handle) return this.handle.agent;
    const agents = this.ctx.get("agents");
    const defaultModel = this.ctx.get("agentDefaultModel");
    if (!agents || !defaultModel) throw new Error("agents/agentDefaultModel 服务不可用");

    const fallback = defaultModel.currentSelection();
    const selection = {
      provider: this.config.provider || fallback.provider,
      model: this.config.model || fallback.model,
      ...(this.config.reasoningEffort
        ? { reasoningEffort: ReasoningEffortId(this.config.reasoningEffort) }
        : {}),
    };
    // 每次用随机 UUID 作为 sessionId：切换目录销毁旧 agent 后，
    // 同名固定 id 的 session 记录可能未及时释放，重建会报
    // `session "<id>" already exists`。随机 id 天然规避该冲突，
    // 与 dsh-headless 的一次性会话做法一致。
    this.handle = await agents.create({
      sessionId: SessionId(`wecom-${randomUUID()}`),
      meta: { cwd: this.cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });
    const agent = this.handle.agent;
    await agent.whenIdle();
    this.ctx.logger?.info?.("wecom-bot: agent ready", { session: String(agent.session.id), cwd: this.cwd });
    return agent;
  }

  /**
   * 切换工作目录：若已有 agent 会话（旧目录已固定），先持久化并销毁，
   * 下一条任务用新目录重建 agent。
   */
  async switchCwd(cwd) {
    if (this.handle) await this.dispose();
    this.cwd = cwd;
  }

  /**
   * 排队执行一次任务。返回任务结果文本；同一会话内串行。
   */
  run(text) {
    const task = this.tail.then(() => this.runNow(text));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  async runNow(text) {
    const agent = await this.ensureAgent();
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    return resolveOutcome(agent.session.events, firstSeq);
  }

  /** 持久化并销毁会话。 */
  async dispose() {
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;
    try {
      const sessions = this.ctx.get("sessions");
      await sessions?.flush(handle.agent.session);
    } catch (error) {
      this.ctx.logger?.warn?.("wecom-bot: session flush failed", error);
    }
    await handle.dispose();
  }
}

/**
 * 挂载 wecom-bot 插件。
 * @param ctx - Cordis 插件上下文。
 * @param config - 校验后的配置。
 */
function apply(ctx, config) {
  if (!config.botId || !config.botSecret) {
    ctx.logger?.warn?.(
      "wecom-bot: botId/botSecret 未配置，插件保持空闲。请设置 WECOM_BOT_ID/WECOM_BOT_SECRET 环境变量，或在 profile 的 cordis.patch.yml 中覆盖 wecom-bot 行的 config。",
    );
    return;
  }

  const client = new WecomClient({
    botId: config.botId,
    botSecret: config.botSecret,
    endpoint: config.wsEndpoint,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    reconnectBaseDelayMs: config.reconnectBaseDelayMs,
    reconnectMaxDelayMs: config.reconnectMaxDelayMs,
    log: (level, ...args) => ctx.logger?.[level]?.(...args),
  });

  /** msgid 去重（网关重连后可能重发）。 */
  const seenMsgIds = new Set();
  /** per-user 模式的会话表。 */
  const sessionsByUser = new Map();

  client.onStatus = (status, info) => {
    ctx.logger?.[status === "connected" ? "info" : "warn"]?.(
      `wecom-bot: ${status}${info ? ` (${info})` : ""}`,
    );
  };

  client.onMessage = (body, reqId) => {
    handleMessage(body, reqId).catch((error) => {
      ctx.logger?.error?.("wecom-bot: task failed", error?.stack ?? error);
    });
  };

  async function handleMessage(body, reqId) {
    const msg = extractMessage(body);
    if (msg === null) return;
    if (seenMsgIds.has(msg.msgid)) return;
    if (seenMsgIds.size > 10_000) seenMsgIds.clear();
    seenMsgIds.add(msg.msgid);

    // 忽略历史消息
    if (config.ignoreOlderThanSec > 0 && msg.createTime > 0) {
      const ageSec = Math.floor(Date.now() / 1000) - msg.createTime;
      if (ageSec > config.ignoreOlderThanSec) {
        ctx.logger?.debug?.("wecom-bot: ignoring old message", { msgid: msg.msgid, ageSec });
        return;
      }
    }

    let taskText = msg.content;
    if (config.stripGroupMentions && msg.chattype === "group") {
      taskText = stripMentions(taskText);
    }
    if (taskText === "") return;

    const streamId = nextReqId("stream");
    const reply = (content) => {
      if (reqId) {
        return client.respond(reqId, streamId, content, true);
      }
      // 没有 req_id（理论上不会发生在回调场景），退化为主动推送
      const chatId = msg.chatid || msg.userid;
      return chunkByBytes(content, 2000).reduce(
        (chain, chunk) => chain.then(() => client.sendTo(chatId, chunk)),
        Promise.resolve(),
      );
    };

    // ── 工作区命令优先 ────────────────────────────────────────────────────
    const command = parseCommand(taskText);
    if (command !== null) {
      try {
        await runCommand(command, msg, reply);
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        ctx.logger?.error?.("wecom-bot: command error", detail);
        await reply(`❌ 命令执行失败：${truncate(detail, config.maxReplyChars)}`).catch(() => {});
      }
      return;
    }

    // ── 普通任务：先推一条中间态，再跑 agent ──────────────────────────────
    if (config.ackOnReceive && reqId) {
      client.respond(reqId, streamId, "✅ 已收到任务，agent 处理中…", false).catch(() => {});
    }

    try {
      let answer;
      if (config.sessionMode === "per-user") {
        const session = sessionFor(msg);
        answer = await session.run(taskText);
      } else {
        const ephemeral = new UserSession(ctx, config, `msg-${randomUUID()}`);
        try {
          answer = await ephemeral.run(taskText);
        } finally {
          await ephemeral.dispose();
        }
      }

      const text = answer === "" ? "（agent 未返回文本结果）" : answer;
      await reply(truncate(text, config.maxReplyChars));
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      ctx.logger?.error?.("wecom-bot: task error", detail);
      await reply(`❌ 任务执行失败：${truncate(detail, config.maxReplyChars)}`).catch(() => {});
    }
  }

  /** per-user 模式下取（或建）某成员的工作区会话。 */
  function sessionFor(msg) {
    const key = `${msg.chattype}:${msg.chatid || msg.userid}`;
    let session = sessionsByUser.get(key);
    if (!session) {
      session = new UserSession(ctx, config, key);
      sessionsByUser.set(key, session);
    }
    return session;
  }

  /** 当前成员的会话工作目录（per-message 模式回退到配置/进程 cwd）。 */
  function currentCwdOf(msg) {
    if (config.sessionMode === "per-user") {
      return sessionFor(msg).cwd;
    }
    return config.cwd || process.cwd();
  }

  /** 执行一条工作区命令并回复结果。 */
  async function runCommand(command, msg, reply) {
    const registry = ctx.get("workspaceRegistry");
    const current = currentCwdOf(msg);

    if (command.kind === "list-workspaces") {
      const rows = registry?.list?.() ?? [];
      await reply(formatWorkspaceList(rows, current));
      return;
    }

    if (command.kind === "show-cwd") {
      await reply(`📍 当前工作目录：${current}`);
      return;
    }

    if (command.kind === "switch-workspace" || command.kind === "set-cwd") {
      if (config.sessionMode !== "per-user") {
        await reply("⚠️ 当前为 per-message 模式（每条消息新建 agent），不支持持久切换目录。请在配置中改用 sessionMode: per-user，或直接在消息里说明要操作哪个目录。");
        return;
      }
      const target = await resolveTargetDir(command.arg, current, registry);
      if (target instanceof Error) {
        await reply(`❌ ${target.message}`);
        return;
      }
      const session = sessionFor(msg);
      await session.switchCwd(target);
      ctx.logger?.info?.("wecom-bot: cwd switched", { user: msg.userid, cwd: target });
      await reply(`✅ 已切换工作目录：\n${target}\n\n下一条消息将在此目录下执行。`);
    }
  }

  // 等待 loader 就绪后启动连接，保证依赖行全部挂载
  const settled = ctx.get("loader")?.await();
  const start = () => client.start();
  if (settled === undefined) start();
  else settled.then(start, start);

  // 插件卸载：断连、销毁所有 agent 会话
  ctx.on("dispose", () => {
    client.stop();
    for (const session of sessionsByUser.values()) {
      session.dispose().catch(() => {});
    }
    sessionsByUser.clear();
  });
}

/** 截断超长文本并追加提示。 */
function truncate(text, maxChars) {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…（内容过长已截断）`;
}

export { Config, UserSession, apply, name };

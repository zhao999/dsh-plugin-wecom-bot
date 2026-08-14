/**
 * 企业微信「智能机器人」长连接协议的纯函数层。
 *
 * 协议基于官方文档《智能机器人长连接》
 * (https://developer.work.weixin.qq.com/document/path/101463)，
 * 帧格式与 cc-connect / CowAgent 等成熟实现交叉验证：
 *
 *   统一帧: { cmd?, headers: { req_id }, body?, errcode?, errmsg? }
 *   订阅:   aibot_subscribe  (body: { bot_id, secret })
 *   心跳:   ping
 *   来消息: aibot_msg_callback (body: { msgid, aibotid, chatid, chattype,
 *            from: { userid }, msgtype, text: { content }, create_time })
 *   回复:   aibot_respond_msg (headers.req_id = 原回调 req_id,
 *            body: { msgtype: "stream", stream: { id, finish, content } })
 *   主动推: aibot_send_msg    (body: { chatid, msgtype: "markdown",
 *            markdown: { content } })
 *
 * 本模块不依赖任何 DSH 服务，便于独立单测。
 * @module dsh-plugin-wecom-bot/wecom
 */

/** 智能机器人长连接默认网关。 */
export const DEFAULT_WS_ENDPOINT = "wss://openws.work.weixin.qq.com";

/** 递增的本地序号，用于生成唯一 req_id（进程内即可，网关只要求唯一）。 */
export function nextReqId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 订阅（鉴权）帧。 */
export function buildSubscribeFrame(botId, secret, reqId) {
  return {
    cmd: "aibot_subscribe",
    headers: { req_id: reqId },
    body: { bot_id: botId, secret },
  };
}

/** 心跳帧。 */
export function buildPingFrame(reqId) {
  return { cmd: "ping", headers: { req_id: reqId } };
}

/**
 * 回复帧：stream 流式回复。finish=false 推中间态（内容为全量替换），
 * finish=true 收尾。stream.id 在整个回复过程中保持不变。
 */
export function buildRespondFrame(reqId, streamId, content, finish) {
  return {
    cmd: "aibot_respond_msg",
    headers: { req_id: reqId },
    body: {
      msgtype: "stream",
      stream: { id: streamId, finish: finish, content },
    },
  };
}

/** 主动推送帧（无原消息 req_id 时使用），markdown 文本。 */
export function buildSendFrame(reqId, chatId, content) {
  return {
    cmd: "aibot_send_msg",
    headers: { req_id: reqId },
    body: {
      chatid: chatId,
      msgtype: "markdown",
      markdown: { content },
    },
  };
}

/** 解析一帧原始文本。返回 null 表示非法 JSON。 */
export function parseFrame(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 判断一帧是否为「响应帧」（无 cmd、带 errcode/errmsg），
 * 用于匹配订阅/心跳/发送的应答。
 */
export function isResponseFrame(frame) {
  return frame !== null && typeof frame === "object" &&
    (frame.cmd === undefined || frame.cmd === "") &&
    frame.errcode !== undefined;
}

/** 判断是否为消息回调帧。 */
export function isMessageCallback(frame) {
  return frame?.cmd === "aibot_msg_callback";
}

/** 判断是否为事件回调帧（如 disconnected_event）。 */
export function isEventCallback(frame) {
  return frame?.cmd === "aibot_event_callback";
}

/** 从回调帧取 req_id。 */
export function frameReqId(frame) {
  return frame?.headers?.req_id ?? "";
}

/**
 * 从 aibot_msg_callback 的 body 提取一条规范化消息。
 * 支持 text 与 voice（语音转写）两种文本类消息；其他类型返回 null。
 */
export function extractMessage(body) {
  if (!body || typeof body !== "object") return null;
  const msgtype = body.msgtype;
  let content = "";
  if (msgtype === "text") {
    content = body.text?.content ?? "";
  } else if (msgtype === "voice") {
    content = body.voice?.content ?? body.voice?.text ?? "";
  } else {
    return null;
  }
  content = content.trim();
  if (content === "") return null;
  return {
    msgid: body.msgid ?? "",
    aibotid: body.aibotid ?? "",
    chatid: body.chatid ?? "",
    chattype: body.chattype ?? "single", // "single" | "group"
    userid: body.from?.userid ?? "",
    msgtype,
    content,
    createTime: body.create_time ?? 0,
  };
}

/**
 * 去掉群聊消息里 @机器人 的提及前缀（企业微信群聊文本会把 @机器人
 * 原样拼进 content）。只应作用于群聊消息。
 */
export function stripMentions(content) {
  return content.replace(/@\S+\s*/g, "").trim();
}

/**
 * 按 UTF-8 字节长度切分消息，避免超出网关的单条长度限制。
 * 返回至少包含一个元素的数组（空串返回 [""]）。
 */
export function chunkByBytes(content, maxBytes) {
  if (maxBytes <= 0) return [content];
  if (content === "") return [""];
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const char of content) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (currentBytes + bytes > maxBytes && current !== "") {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/**
 * 从 agent 会话事件流里汇总最后一次 assistant 文本与回合结局
 * （与 dsh-headless 的汇总逻辑一致）。
 * @param events - session.events
 * @param firstSeq - 本次任务起始 seq
 */
export function summarizeEvents(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data.message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

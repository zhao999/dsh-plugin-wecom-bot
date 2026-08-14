/**
 * 协议纯函数与客户端的单元测试（node:test，零外部依赖）。
 * 运行：npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPingFrame,
  buildRespondFrame,
  buildSendFrame,
  buildSubscribeFrame,
  chunkByBytes,
  extractMessage,
  isEventCallback,
  isMessageCallback,
  isResponseFrame,
  nextReqId,
  parseFrame,
  stripMentions,
  summarizeEvents,
} from "../lib/wecom.js";
import { WecomClient } from "../lib/client.js";

// ── 帧构建 ────────────────────────────────────────────────────────────────

test("buildSubscribeFrame 携带 bot_id 与 secret", () => {
  const frame = buildSubscribeFrame("bot1", "secret1", "req1");
  assert.equal(frame.cmd, "aibot_subscribe");
  assert.deepEqual(frame.headers, { req_id: "req1" });
  assert.deepEqual(frame.body, { bot_id: "bot1", secret: "secret1" });
});

test("buildPingFrame 只有 cmd 与 req_id", () => {
  const frame = buildPingFrame("ping1");
  assert.deepEqual(frame, { cmd: "ping", headers: { req_id: "ping1" } });
});

test("buildRespondFrame 生成 stream 回复帧", () => {
  const frame = buildRespondFrame("req9", "s1", "hello", true);
  assert.equal(frame.cmd, "aibot_respond_msg");
  assert.deepEqual(frame.headers, { req_id: "req9" });
  assert.deepEqual(frame.body, {
    msgtype: "stream",
    stream: { id: "s1", finish: true, content: "hello" },
  });
});

test("buildSendFrame 生成 markdown 主动推送帧", () => {
  const frame = buildSendFrame("req8", "chat1", "hi");
  assert.equal(frame.cmd, "aibot_send_msg");
  assert.deepEqual(frame.body, {
    chatid: "chat1",
    msgtype: "markdown",
    markdown: { content: "hi" },
  });
});

test("nextReqId 生成带前缀的唯一 id", () => {
  const a = nextReqId("ping");
  const b = nextReqId("ping");
  assert.ok(a.startsWith("ping_"));
  assert.notEqual(a, b);
});

// ── 帧解析 ────────────────────────────────────────────────────────────────

test("parseFrame 非法 JSON 返回 null", () => {
  assert.equal(parseFrame("not json"), null);
  assert.equal(parseFrame(""), null);
});

test("isResponseFrame 识别无 cmd 的应答帧", () => {
  assert.equal(isResponseFrame({ headers: { req_id: "x" }, errcode: 0, errmsg: "ok" }), true);
  assert.equal(isResponseFrame({ cmd: "aibot_msg_callback", headers: { req_id: "x" } }), false);
  assert.equal(isResponseFrame(null), false);
});

test("isMessageCallback / isEventCallback 识别回调帧", () => {
  assert.equal(isMessageCallback({ cmd: "aibot_msg_callback" }), true);
  assert.equal(isEventCallback({ cmd: "aibot_event_callback" }), true);
  assert.equal(isMessageCallback({ cmd: "ping" }), false);
});

// ── 消息提取 ──────────────────────────────────────────────────────────────

const textBody = {
  msgid: "m1",
  aibotid: "bot1",
  chatid: "chat9",
  chattype: "single",
  from: { userid: "zhangsan" },
  msgtype: "text",
  text: { content: "  帮我跑个测试  " },
  create_time: 1700000000,
};

test("extractMessage 提取文本消息并 trim", () => {
  const msg = extractMessage(textBody);
  assert.equal(msg.msgid, "m1");
  assert.equal(msg.userid, "zhangsan");
  assert.equal(msg.chattype, "single");
  assert.equal(msg.content, "帮我跑个测试");
  assert.equal(msg.createTime, 1700000000);
});

test("extractMessage 支持语音转写", () => {
  const msg = extractMessage({
    ...textBody,
    msgtype: "voice",
    voice: { content: "语音内容" },
  });
  assert.equal(msg.msgtype, "voice");
  assert.equal(msg.content, "语音内容");
});

test("extractMessage 忽略非文本消息与空内容", () => {
  assert.equal(extractMessage({ ...textBody, msgtype: "image" }), null);
  assert.equal(extractMessage({ ...textBody, text: { content: "   " } }), null);
  assert.equal(extractMessage(null), null);
});

test("stripMentions 去掉 @提及", () => {
  assert.equal(stripMentions("@张三 帮我看看这个"), "帮我看看这个");
  assert.equal(stripMentions("你好 @机器人 "), "你好");
  assert.equal(stripMentions("没有提及"), "没有提及");
});

// ── 分块 ──────────────────────────────────────────────────────────────────

test("chunkByBytes 按 UTF-8 字节切分（多字节字符不截断）", () => {
  // 每个中文字符 3 字节
  const chunks = chunkByBytes("一二三四五六", 6);
  assert.deepEqual(chunks, ["一二", "三四", "五六"]);
});

test("chunkByBytes 空串与超限单字符", () => {
  assert.deepEqual(chunkByBytes("", 6), [""]);
  // 单字符超过预算时保持完整，不拆开多字节字符
  assert.deepEqual(chunkByBytes("一二", 1), ["一", "二"]);
  assert.deepEqual(chunkByBytes("abc", 0), ["abc"]);
});

// ── 事件汇总 ──────────────────────────────────────────────────────────────

test("summarizeEvents 取最后一次 assistant 文本与结局", () => {
  const events = [
    { seq: 0, type: "turn/start" },
    { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一版" }] } } },
    { seq: 2, type: "turn/end", data: { reason: { kind: "completed" } } },
  ];
  const outcome = summarizeEvents(events, 0);
  assert.equal(outcome.text, "第一版");
  assert.equal(outcome.reason.kind, "completed");
});

test("summarizeEvents 只统计 firstSeq 之后的事件", () => {
  const events = [
    { seq: 0, type: "assistant/message", data: { message: { content: [{ type: "text", text: "旧文本" }] } } },
    { seq: 5, type: "turn/start" },
    { seq: 6, type: "assistant/message", data: { message: { content: [{ type: "text", text: "新文本" }] } } },
  ];
  const outcome = summarizeEvents(events, 5);
  assert.equal(outcome.text, "新文本");
});

test("summarizeEvents 忽略非文本块", () => {
  const events = [
    { seq: 0, type: "turn/start" },
    { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "tool-call" }] } } },
  ];
  const outcome = summarizeEvents(events, 0);
  assert.equal(outcome.text, "");
});

// ── 客户端（假 socket）────────────────────────────────────────────────────

/** 可编程假 WebSocket：录制发送帧、回放接收帧。 */
class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = 0;
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this._emit("close", { code: 1000 });
  }
  _emit(type, event) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  _open() {
    this.readyState = 1;
    this._emit("open", {});
  }
  _receive(frame) {
    this._emit("message", { data: JSON.stringify(frame) });
  }
}

/** 让 Promise 链在微任务后继续，等待异步处理完成。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 建立连接并完成订阅（start → open → 应答订阅帧）。 */
async function connect(client, sockets) {
  client.start();
  sockets[0]._open();
  await tick(); // 等订阅帧发出
  assert.equal(sockets[0].sent[0].cmd, "aibot_subscribe");
  sockets[0]._receive({
    headers: { req_id: sockets[0].sent[0].headers.req_id },
    errcode: 0,
    errmsg: "ok",
  });
  await tick();
}

function makeClient(opts = {}) {
  const sockets = [];
  const client = new WecomClient({
    botId: "bot1",
    botSecret: "secret1",
    heartbeatIntervalMs: 50,
    reconnectBaseDelayMs: 10,
    reconnectMaxDelayMs: 20,
    log: () => {},
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...opts,
  });
  return { client, sockets };
}

test("client: 连接→订阅→收到应答后 connected", async () => {
  const { client, sockets } = makeClient();
  const statuses = [];
  client.onStatus = (s) => statuses.push(s);

  await connect(client, sockets);
  assert.deepEqual(sockets[0].sent[0].body, { bot_id: "bot1", secret: "secret1" });
  assert.ok(statuses.includes("connected"));

  client.stop();
  await tick();
});

test("client: 订阅失败抛出并进入重连", async () => {
  const { client, sockets } = makeClient();
  const statuses = [];
  client.onStatus = (s) => statuses.push(s);

  client.start();
  sockets[0]._open();
  await tick();
  sockets[0]._receive({
    headers: { req_id: sockets[0].sent[0].headers.req_id },
    errcode: 40001,
    errmsg: "bad secret",
  });
  await tick();
  // 短暂退避后出现第二个连接
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(sockets.length >= 2, "应触发重连");
  assert.ok(statuses.includes("connecting"));

  client.stop();
  await tick();
});

test("client: 消息回调分发并携带 req_id", async () => {
  const { client, sockets } = makeClient();
  const received = [];
  client.onMessage = (body, reqId) => received.push({ body, reqId });

  await connect(client, sockets);

  sockets[0]._receive({
    cmd: "aibot_msg_callback",
    headers: { req_id: "cb-1" },
    body: textBody,
  });
  await tick();

  assert.equal(received.length, 1);
  assert.equal(received[0].reqId, "cb-1");
  assert.equal(received[0].body.text.content, "  帮我跑个测试  ");

  client.stop();
  await tick();
});

test("client: respond 发送 stream 回复帧", async () => {
  const { client, sockets } = makeClient();
  await connect(client, sockets);

  await client.respond("cb-1", "stream-1", "答案", true);
  const last = sockets[0].sent.at(-1);
  assert.equal(last.cmd, "aibot_respond_msg");
  assert.deepEqual(last.headers, { req_id: "cb-1" });
  assert.deepEqual(last.body.stream, { id: "stream-1", finish: true, content: "答案" });

  client.stop();
  await tick();
});

test("client: 心跳周期性发送并可被应答重置", async () => {
  const { client, sockets } = makeClient();
  await connect(client, sockets);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const pings = sockets[0].sent.filter((f) => f.cmd === "ping");
  assert.ok(pings.length >= 1, "应至少发送一次 ping");

  // 应答最后一个 ping
  sockets[0]._receive({ headers: { req_id: pings.at(-1).headers.req_id }, errcode: 0 });
  await tick();
  // 不强制断开：连接仍在
  assert.ok(client._socket !== null);

  client.stop();
  await tick();
});

test("client: 断线后自动重连（退避）", async () => {
  const { client, sockets } = makeClient();
  await connect(client, sockets);

  sockets[0]._emit("close", { code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(sockets.length >= 2, "应建立第二个连接");

  client.stop();
  await tick();
});

test("client: stop 后不再重连", async () => {
  const { client, sockets } = makeClient();
  await connect(client, sockets);

  client.stop();
  await tick();
  assert.equal(sockets.length, 1, "stop 后不应再建立连接");

  await tick();
});

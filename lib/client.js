/**
 * 企业微信「智能机器人」长连接客户端。
 *
 * 维护到 wss://openws.work.weixin.qq.com 的单一 WebSocket 连接：
 * 连接 → aibot_subscribe 鉴权 → 30s 心跳 → 接收 aibot_msg_callback，
 * 断线按指数退避重连。主动回复走 aibot_respond_msg（stream 流式），
 * 无 req_id 的主动推送走 aibot_send_msg。
 *
 * 传输用 ws 库而非 Node 内置 WebSocket：企业微信网关要求 TLS ClientHello
 * 携带 ALPN「http/1.1」，内置 undici WebSocket 不带 ALPN 会被 400 拒绝。
 *
 * socket 工厂可注入，便于单测（用假 socket 录制帧、回放帧）。
 * @module dsh-plugin-wecom-bot/client
 */
import { createRequire } from "node:module";
import https from "node:https";
import {
  buildPingFrame,
  buildRespondFrame,
  buildSendFrame,
  buildSubscribeFrame,
  frameReqId,
  isEventCallback,
  isMessageCallback,
  isResponseFrame,
  nextReqId,
  parseFrame,
} from "./wecom.js";

// 企业微信长连接网关（Wwebsvr）要求 TLS ClientHello 携带 ALPN「http/1.1」，
// 否则握手直接 400。Node 内置 WebSocket（undici）与 http.request 默认都不
// 发送 ALPN 扩展，因此这里用 ws 库 + 显式 ALPN 的 https.Agent 建连。
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
/** 带 ALPN http/1.1 的 TLS agent，供 ws 握手使用。 */
const GATEWAY_AGENT = new https.Agent({ ALPNProtocols: ["http/1.1"] });

/** 连续未收到心跳应答达到该次数即判定连接失效，主动断开触发重连。 */
const MAX_MISSED_PONG = 2;

/**
 * @param {object} opts
 * @param {string} opts.botId      智能机器人 BotID
 * @param {string} opts.botSecret  智能机器人 Secret
 * @param {string} [opts.endpoint] 网关地址，默认 wss://openws.work.weixin.qq.com
 * @param {number} [opts.heartbeatIntervalMs] 心跳间隔，默认 30_000
 * @param {number} [opts.reconnectBaseDelayMs] 重连初始退避，默认 1_000
 * @param {number} [opts.reconnectMaxDelayMs]  重连最大退避，默认 30_000
 * @param {() => WebSocket} [opts.socketFactory] 连接工厂（默认用全局 WebSocket）
 */
export class WecomClient {
  constructor(opts) {
    this.botId = opts.botId;
    this.botSecret = opts.botSecret;
    this.endpoint = opts.endpoint ?? "wss://openws.work.weixin.qq.com";
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs ?? 30_000;
    this.socketFactory = opts.socketFactory ?? (() => new WebSocket(this.endpoint, { agent: GATEWAY_AGENT }));

    /** 收到用户消息回调: (msg, reqId) => void，msg 为 extractMessage 的规范化消息 */
    this.onMessage = null;
    /** 状态回调: (status: "connecting"|"connected"|"disconnected"|"fatal", info?: string) => void */
    this.onStatus = null;
    /** 日志回调: (level, ...args) => void，缺省走 console */
    this.log = opts.log ?? ((level, ...args) => console[level](...args));

    this._stopped = false;
    this._socket = null;
    this._reqSeq = 0;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._missedPong = 0;
    this._stableSince = 0;
    this._failStreak = 0;
    this._sendLock = Promise.resolve();
  }

  /** 开始连接（幂等）。 */
  start() {
    if (this._started) return;
    this._started = true;
    this._stopped = false;
    this._connectLoop();
  }

  /** 停止连接并清理资源。 */
  stop() {
    this._stopped = true;
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try {
        socket.close(1000, "plugin stopped");
      } catch {
        /* 已关闭则忽略 */
      }
    }
  }

  _generateReqId(prefix) {
    this._reqSeq += 1;
    return `${prefix}_${this._reqSeq}_${Date.now().toString(36)}`;
  }

  _emitStatus(status, info) {
    try {
      this.onStatus?.(status, info);
    } catch (error) {
      this.log("warn", "wecom-bot: onStatus callback failed", error);
    }
  }

  /** 连接循环：runConnection 返回（断开/出错）后按退避重连。 */
  _connectLoop() {
    if (this._stopped) return;
    this._emitStatus("connecting");
    this._runConnection().catch((error) => {
      this.log("warn", "wecom-bot: connection failed", error?.message ?? error);
    }).finally(() => {
      // 连接已结束：清掉已关闭 socket 的引用，避免心跳继续向死 socket 发送。
      this._socket = null;
      if (this._stopped) return;
      const aliveLong = Date.now() - this._stableSince > 2 * this.heartbeatIntervalMs;
      const delay = aliveLong
        ? this.reconnectBaseDelayMs
        : Math.min(
          this.reconnectBaseDelayMs * 2 ** Math.max(0, this._failStreak ?? 0),
          this.reconnectMaxDelayMs,
        );
      this._failStreak = (this._failStreak ?? 0) + 1;
      this._reconnectTimer = setTimeout(() => this._connectLoop(), delay);
    });
  }

  /** 建立一次连接：订阅、心跳、读帧；返回即代表连接结束。 */
  async _runConnection() {
    if (this._stopped) throw new Error("stopped");
    const socket = this.socketFactory();
    this._socket = socket;

    let openSettled = false;
    // ws 的 error 事件必须有监听器，否则连接失败会让进程崩溃；
    // 失败统一由随后的 close 事件处理（重连循环负责恢复）。
    socket.addEventListener("error", () => {});
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        openSettled = true;
        resolve();
      }, { once: true });
      socket.addEventListener("close", () => {
        if (!openSettled) {
          openSettled = true;
          reject(new Error("connection closed before open"));
        }
      }, { once: true });
    });

    const frameHandlers = {
      onFrame: (frame) => this._handleFrame(frame),
      onClosed: () => {},
    };

    socket.addEventListener("message", (event) => {
      const frame = parseFrame(event.data);
      if (frame === null) {
        this.log("warn", "wecom-bot: non-JSON frame ignored");
        return;
      }
      frameHandlers.onFrame(frame);
    });

    await opened;

    // 订阅鉴权
    const subReqId = this._generateReqId("aibot_subscribe");
    this._send(buildSubscribeFrame(this.botId, this.botSecret, subReqId));
    const subscribeAck = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscribe timeout")), 10_000);
      frameHandlers.onFrame = (frame) => {
        if (isResponseFrame(frame) && frameReqId(frame) === subReqId) {
          clearTimeout(timer);
          resolve(frame);
        }
      };
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error("connection closed before subscribe ack"));
      });
    });
    if (subscribeAck.errcode !== 0) {
      throw new Error(`subscribe failed: errcode=${subscribeAck.errcode} errmsg=${subscribeAck.errmsg}`);
    }

    this._missedPong = 0;
    this._failStreak = 0;
    this._stableSince = Date.now();
    this._emitStatus("connected");
    this.log("info", "wecom-bot: subscribed");

    // 心跳
    this._startHeartbeat();

    // 读循环：message 之外的分发交给 onFrame（订阅应答已消费）
    frameHandlers.onFrame = (frame) => this._handleFrame(frame);
    await new Promise((resolve) => {
      socket.addEventListener("close", () => resolve());
    });
  }
  _startHeartbeat() {
    if (this._heartbeatTimer !== null) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (this._socket === null) return;
      if (this._missedPong >= MAX_MISSED_PONG) {
        this.log("warn", "wecom-bot: heartbeat ack missed, forcing reconnect");
        try {
          this._socket.close(4000, "heartbeat timeout");
        } catch {
          /* ignore */
        }
        return;
      }
      this._missedPong += 1;
      this._send(buildPingFrame(this._generateReqId("ping")));
    }, this.heartbeatIntervalMs);
  }

  /**
   * 串行化发送。返回的 Promise 反映**本次**发送的结果（失败会 reject，
   * 调用方如回复逻辑可感知），同时保证后续发送不受失败影响。
   */
  _send(frame) {
    const socket = this._socket;
    if (socket === null) return Promise.reject(new Error("not connected"));
    const result = this._sendLock.then(() => {
      socket.send(JSON.stringify(frame));
    });
    this._sendLock = result.catch((error) => {
      this.log("warn", "wecom-bot: ws send failed", error?.message ?? error);
    });
    return result;
  }

  _handleFrame(frame) {
    if (isMessageCallback(frame)) {
      const reqId = frameReqId(frame);
      try {
        this.onMessage?.(frame.body ?? {}, reqId);
      } catch (error) {
        this.log("warn", "wecom-bot: message handler failed", error?.message ?? error);
      }
      return;
    }
    if (isEventCallback(frame)) {
      const eventType = frame.body?.event?.eventtype ?? "unknown";
      if (eventType === "disconnected_event") {
        this.log("warn", "wecom-bot: another connection took over this bot");
      } else {
        this.log("debug", `wecom-bot: event ${eventType}`);
      }
      return;
    }
    if (isResponseFrame(frame)) {
      const reqId = frameReqId(frame);
      if (reqId.startsWith("ping")) {
        this._missedPong = 0;
        return;
      }
      if (frame.errcode !== 0) {
        this.log("warn", `wecom-bot: ack error req_id=${reqId} errcode=${frame.errcode} errmsg=${frame.errmsg}`);
      }
    }
  }

  /**
   * stream 流式回复。reqId 为原消息回调的 req_id；同一回复的
   * streamId 不变，finish=true 表示最终内容（全量替换）。
   */
  respond(reqId, streamId, content, finish = true) {
    return this._send(buildRespondFrame(reqId, streamId, content, finish));
  }

  /** 主动推送 markdown 消息到指定 chatid（无原 req_id 时使用）。 */
  sendTo(chatId, content) {
    return this._send(buildSendFrame(this._generateReqId("aibot_send_msg"), chatId, content));
  }
}

/**
 * dsh-plugin-wecom-bot 类型声明。
 * 插件本体为纯 JS（ESM），此文件仅为编辑器提供提示。
 */

/** 规范化的企业微信消息。 */
export interface WecomMessage {
  msgid: string;
  aibotid: string;
  chatid: string;
  /** "single" 私聊 | "group" 群聊 */
  chattype: "single" | "group";
  /** 发送者 userid */
  userid: string;
  msgtype: "text" | "voice";
  content: string;
  createTime: number;
}

/** 插件配置。 */
export interface WecomBotConfig {
  botId: string;
  botSecret: string;
  wsEndpoint?: string;
  heartbeatIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  sessionMode?: "per-user" | "per-message";
  cwd?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  ignoreOlderThanSec?: number;
  maxReplyChars?: number;
  ackOnReceive?: boolean;
  stripGroupMentions?: boolean;
}

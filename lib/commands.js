/**
 * 企业微信 bot 的工作区命令层：命令解析与目录解析的纯函数。
 *
 * 支持的命令（私聊/群聊均可用，`#` 前缀命令与中文短语两种写法）：
 *   - 查看工作区 / #ws / #workspace / #工作区        → 列出全部工作区
 *   - 切换工作区 <名称|路径> / #ws <名称|路径>       → 切换会话工作目录
 *   - #cwd [路径]                                    → 查看 / 设置当前目录
 *
 * 本模块不依赖 DSH 服务，目录校验所需的 fs 操作可注入，便于单测。
 * @module dsh-plugin-wecom-bot/commands
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

/**
 * 解析一条 bot 消息是否为工作区命令。
 * @param {string} text - 已去除 @提及、trim 过的消息文本。
 * @returns 命令对象 { kind, arg? } 或 null（不是命令，交给 agent 处理）。
 */
export function parseCommand(text) {
  const t = text.trim();
  if (t === "") return null;

  // ── # 前缀命令 ──────────────────────────────────────────────────────────
  if (t.startsWith("#")) {
    const body = t.slice(1).trim();
    const match = body.match(/^(\S+)(?:\s+(.+))?$/);
    if (!match) return null;
    const [, head, rest] = match;
    const arg = (rest ?? "").trim();
    if (/^(ws|workspace|工作区)$/i.test(head)) {
      return arg ? { kind: "switch-workspace", arg } : { kind: "list-workspaces" };
    }
    if (/^cwd|目录$/i.test(head)) {
      return arg ? { kind: "set-cwd", arg } : { kind: "show-cwd" };
    }
    return null; // 其他 # 前缀不是本插件命令，交给 agent
  }

  // ── 中文/英文短语 ──────────────────────────────────────────────────────
  if (
    t === "工作区" ||
    /^(查看|列出|显示)\s*(工作区|工作目录)$/.test(t) ||
    /^(工作区|工作目录)\s*(列表|list)$/i.test(t) ||
    /^(list|show)\s+(workspaces?|workspace)$/i.test(t)
  ) {
    return { kind: "list-workspaces" };
  }
  const sw = t.match(/^(?:切换|设置|进入)\s*(?:工作区|工作目录|workspace)\s*(?:到|为|至)?[：:\s]+(.+)$/i);
  if (sw) {
    const arg = sw[1].trim();
    if (arg !== "") return { kind: "switch-workspace", arg };
  }
  if (/^(?:查看|显示)?\s*(?:当前)?\s*(?:工作)?目录\s*$/i.test(t) && !/工作区/.test(t)) {
    return { kind: "show-cwd" };
  }
  return null;
}

/**
 * 解析切换目标目录：支持绝对路径、相对路径（相对 baseCwd）、
 * 以及已注册工作区的标题（title）匹配。
 * @param {string} arg - 命令参数。
 * @param {string} baseCwd - 当前目录（用于解析相对路径）。
 * @param {{ list: () => Array<{ path: string; title: string; status?: () => string }> } | undefined} registry
 * @param {object} [fs] - 可注入的 fs 实现（测试用）。
 * @returns {Promise<string | Error>} 规范化后的绝对路径，或 Error。
 */
export async function resolveTargetDir(arg, baseCwd, registry, fs = { realpathSync, statSync }) {
  const raw = arg.trim();
  if (raw === "") return new Error("缺少目标目录参数，例如：切换工作区 /path/to/dir 或 #ws productv4-web");

  // 1. 已注册工作区标题匹配（精确/忽略大小写/前缀）
  const rows = registry?.list() ?? [];
  const byTitle = rows.filter(
    (w) => w.title === raw || w.title.toLowerCase() === raw.toLowerCase() || w.title.startsWith(raw),
  );
  if (byTitle.length === 1) {
    const w = byTitle[0];
    if (typeof w.status === "function" && w.status() === "missing-dir") {
      return new Error(`工作区「${w.title}」的目录已不存在：${w.path}`);
    }
    return w.path;
  }
  if (byTitle.length > 1) {
    return new Error(`「${raw}」匹配到多个工作区（${byTitle.map((w) => w.title).join("、")}），请用完整路径`);
  }

  // 2. 路径解析
  const candidate = isAbsolute(raw) ? raw : resolvePath(baseCwd, raw);
  try {
    const canon = fs.realpathSync(candidate);
    const stat = fs.statSync(canon);
    if (!stat.isDirectory()) return new Error(`不是目录：${candidate}`);
    return canon;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return new Error(`目录不可用：${candidate}（${why}）`);
  }
}

/**
 * 格式化工作区列表回复。
 * @param {Array<{ path: string; title: string; status?: () => string }>} rows
 * @param {string} currentCwd
 */
export function formatWorkspaceList(rows, currentCwd) {
  const lines = rows.map((w, i) => {
    const missing = typeof w.status === "function" && w.status() === "missing-dir";
    return `${i + 1}. ${w.path}${missing ? "（⚠️ 目录缺失）" : ""}`;
  });
  return `📂 已注册工作区（${rows.length} 个）：\n${lines.length ? lines.join("\n") : "（暂无）"}\n\n📍 当前工作目录：${currentCwd}\n\n💡 切换：发送「切换工作区 <名称或路径>」或「#ws <名称或路径>」`;
}

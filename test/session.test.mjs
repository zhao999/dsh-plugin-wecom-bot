/**
 * UserSession 集成单测：
 * - 切换工作区 → 重建 agent 不再发生 `session already exists`（随机 sessionId）
 * - setup 挂载 agent preset（服务方法），无服务时优雅降级
 * - 切换与任务串行，不中断进行中的任务
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UserSession } from "../lib/index.js";

/**
 * 构造最小 mock 上下文。
 * @param {object} [presetCfg] - 传 { defaultId? } 表示提供 agentPresets 服务，
 *   挂载记录进返回的 mounted 数组；不传表示无该服务（优雅降级路径）。
 */
function makeFakeCtx(presetCfg) {
  const created = [];
  const disposed = [];
  const mounted = [];
  let presets;
  if (presetCfg) {
    presets = {
      defaultId: presetCfg.defaultId ?? "standard",
      mount: async (agentCtx, id) => {
        mounted.push(id);
        return { id };
      },
    };
  }
  const agents = {
    create: async (opts) => {
      created.push({ sessionId: String(opts.sessionId), cwd: opts.meta?.cwd });
      const agent = {
        id: opts.sessionId,
        session: { id: opts.sessionId, seq: 0, events: [] },
        whenIdle: async () => {},
        followup: () => {},
      };
      // 模拟 factory：发布前调用 setup（真实路径 setupAndPublish 的行为）
      if (typeof opts.setup === "function") {
        const agentCtx = {
          get: (name) => (name === "agentPresets" ? presets : undefined),
          on: () => () => {},
        };
        await opts.setup(agentCtx);
      }
      return {
        agent,
        dispose: async () => {
          disposed.push(String(opts.sessionId));
        },
      };
    },
  };
  const defaultModel = { currentSelection: () => ({ provider: "deepseek", model: "mock" }) };
  const sessions = { flush: async () => true };
  const ctx = {
    get: (name) => ({ agents, agentDefaultModel: defaultModel, sessions }[name]),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
  return { ctx, created, disposed, mounted };
}

const config = { cwd: "/base" };

test("UserSession: 首次 ensureAgent 创建随机 sessionId", async () => {
  const { ctx, created } = makeFakeCtx();
  const session = new UserSession(ctx, config, "single:user1");
  const agent = await session.ensureAgent();
  assert.equal(created.length, 1);
  assert.match(created[0].sessionId, /^wecom-[0-9a-f-]{36}$/);
  assert.equal(agent.session.id, created[0].sessionId);
  assert.equal(created[0].cwd, "/base", "首次创建使用配置 cwd");
});

test("UserSession: 未切换时复用同一 agent，不重复创建", async () => {
  const { ctx, created } = makeFakeCtx();
  const session = new UserSession(ctx, config, "single:user1");
  await session.ensureAgent();
  await session.ensureAgent();
  assert.equal(created.length, 1, "同一会话应复用 handle");
});

test("UserSession: 切换 cwd 后重建使用全新 sessionId（不再冲突）", async () => {
  const { ctx, created, disposed } = makeFakeCtx();
  const session = new UserSession(ctx, config, "single:user1");
  await session.ensureAgent();
  const first = created[0];

  await session.switchCwd("/new/dir");
  assert.equal(session.cwd, "/new/dir");
  assert.deepEqual(disposed, [first.sessionId], "旧 agent 应被 dispose");

  await session.ensureAgent();
  assert.equal(created.length, 2, "切换后应重建 agent");
  assert.notEqual(created[1].sessionId, first.sessionId, "新 sessionId 必须与旧的不同");
  assert.match(created[1].sessionId, /^wecom-[0-9a-f-]{36}$/);
  assert.equal(created[1].cwd, "/new/dir", "重建 agent 必须使用新目录");
});

test("UserSession: 新建会话（无旧 handle）切换只更新 cwd", async () => {
  const { ctx, created, disposed } = makeFakeCtx();
  const session = new UserSession(ctx, config, "single:user1");
  await session.switchCwd("/fresh/dir");
  assert.equal(session.cwd, "/fresh/dir");
  assert.equal(created.length, 0);
  assert.equal(disposed.length, 0);
});

// ── agent preset 挂载 ────────────────────────────────────────────────────

test("UserSession: setup 通过服务方法挂载默认 preset", async () => {
  const { ctx, mounted } = makeFakeCtx({});
  const session = new UserSession(ctx, config, "single:user1");
  await session.ensureAgent();
  assert.deepEqual(mounted, ["standard"], "应挂载默认 preset standard");
});

test("UserSession: 配置 agentPreset 时挂载指定 preset", async () => {
  const { ctx, mounted } = makeFakeCtx({ defaultId: "code" });
  const session = new UserSession(ctx, { ...config, agentPreset: "code" }, "single:user1");
  await session.ensureAgent();
  assert.deepEqual(mounted, ["code"]);
});

test("UserSession: 无 agentPresets 服务时优雅降级（不抛错、不挂载）", async () => {
  const { ctx, created } = makeFakeCtx();
  const session = new UserSession(ctx, config, "single:user1");
  const agent = await session.ensureAgent();
  assert.ok(agent, "仍应成功创建 agent");
  assert.equal(created.length, 1);
});

// ── 切换与任务串行 ───────────────────────────────────────────────────────

test("UserSession: 任务运行中切换会先等任务完成再 dispose", async () => {
  const { ctx, created, disposed } = makeFakeCtx();
  // 让 agent.whenIdle 可控：记录 resolve
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const agents = ctx.get("agents");
  const origCreate = agents.create;
  agents.create = async (opts) => {
    const result = await origCreate(opts);
    result.agent.whenIdle = async () => {
      await gate;
    };
    return result;
  };
  const session = new UserSession(ctx, config, "single:user1");

  let taskDone = false;
  const runPromise = session.run("慢任务").then((v) => { taskDone = true; return v; });
  // 任务开始后（ensureAgent 完成、进入 whenIdle 等待）再发起切换
  await new Promise((resolve) => setTimeout(resolve, 20));
  const switchPromise = session.switchCwd("/new/dir");
  let switchDone = false;
  switchPromise.then(() => { switchDone = true; });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(switchDone, false, "切换应等待运行中的任务完成");
  assert.equal(disposed.length, 0, "任务完成前不应 dispose");

  release();
  await runPromise;
  await switchPromise;
  assert.equal(taskDone, true);
  assert.equal(switchDone, true);
  assert.equal(disposed.length, 1, "任务完成后才 dispose 旧 agent");
  assert.equal(session.cwd, "/new/dir");
});

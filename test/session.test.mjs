/**
 * UserSession 集成单测：验证「切换工作区 → 重建 agent」不再发生
 * `session already exists` 冲突（sessionId 每次用随机 UUID）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UserSession } from "../lib/index.js";

/** 构造最小 mock 上下文，记录 create 的 sessionId 与 dispose 的调用。 */
function makeFakeCtx() {
  const created = [];
  const disposed = [];
  const agents = {
    create: async (opts) => {
      created.push(String(opts.sessionId));
      const agent = {
        id: opts.sessionId,
        session: { id: opts.sessionId, seq: 0, events: [] },
        whenIdle: async () => {},
        followup: () => {},
      };
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
  return { ctx, created, disposed };
}

const config = { cwd: "/base" };

test("UserSession: 首次 ensureAgent 创建随机 sessionId", async () => {
  const { ctx, created } = makeFakeCtx();
  const session = new UserSession(ctx, config, "single:user1");
  const agent = await session.ensureAgent();
  assert.equal(created.length, 1);
  assert.match(created[0], /^wecom-[0-9a-f-]{36}$/);
  assert.equal(agent.session.id, created[0]);
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
  const firstId = created[0];

  await session.switchCwd("/new/dir");
  assert.equal(session.cwd, "/new/dir");
  assert.deepEqual(disposed, [firstId], "旧 agent 应被 dispose");

  await session.ensureAgent();
  assert.equal(created.length, 2, "切换后应重建 agent");
  assert.notEqual(created[1], firstId, "新 sessionId 必须与旧的不同");
  assert.match(created[1], /^wecom-[0-9a-f-]{36}$/);
});

test("UserSession: 新建会话（无旧 handle）切换只更新 cwd", async () => {
  const { ctx, created, disposed } = makeFakeCtx();
  const session = new UserSession(ctx, config, "single:user1");
  await session.switchCwd("/fresh/dir");
  assert.equal(session.cwd, "/fresh/dir");
  assert.equal(created.length, 0);
  assert.equal(disposed.length, 0);
});

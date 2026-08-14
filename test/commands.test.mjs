/**
 * 工作区命令层单测（node:test）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatWorkspaceList, parseCommand, resolveTargetDir } from "../lib/commands.js";

// ── parseCommand ──────────────────────────────────────────────────────────

test("parseCommand: 列出工作区的多种写法", () => {
  for (const text of ["查看工作区", "列出工作区", "工作区列表", "查看工作目录", "工作区", "#ws", "#workspace", "#工作区", "list workspaces"]) {
    assert.deepEqual(parseCommand(text), { kind: "list-workspaces" }, `input: ${text}`);
  }
});

test("parseCommand: 切换工作区（名称/路径）", () => {
  assert.deepEqual(parseCommand("切换工作区 /tmp/foo"), { kind: "switch-workspace", arg: "/tmp/foo" });
  assert.deepEqual(parseCommand("切换工作区到 /tmp/foo"), { kind: "switch-workspace", arg: "/tmp/foo" });
  assert.deepEqual(parseCommand("切换工作区为 productv4-web"), { kind: "switch-workspace", arg: "productv4-web" });
  assert.deepEqual(parseCommand("设置工作目录为 /tmp/foo"), { kind: "switch-workspace", arg: "/tmp/foo" });
  assert.deepEqual(parseCommand("#ws /tmp/foo"), { kind: "switch-workspace", arg: "/tmp/foo" });
  assert.deepEqual(parseCommand("#ws productv4-web"), { kind: "switch-workspace", arg: "productv4-web" });
  assert.deepEqual(parseCommand("#工作区 /tmp/foo"), { kind: "switch-workspace", arg: "/tmp/foo" });
});

test("parseCommand: 切换工作区无参数也识别（由 runCommand 提示用法）", () => {
  assert.deepEqual(parseCommand("切换工作区"), { kind: "switch-workspace", arg: "" });
  assert.deepEqual(parseCommand("切换工作区 "), { kind: "switch-workspace", arg: "" });
  assert.deepEqual(parseCommand("设置工作目录"), { kind: "switch-workspace", arg: "" });
});

test("parseCommand: 查看/设置当前目录", () => {
  assert.deepEqual(parseCommand("#cwd"), { kind: "show-cwd" });
  assert.deepEqual(parseCommand("查看目录"), { kind: "show-cwd" });
  assert.deepEqual(parseCommand("查看当前目录"), { kind: "show-cwd" });
  assert.deepEqual(parseCommand("#cwd /tmp/foo"), { kind: "set-cwd", arg: "/tmp/foo" });
  assert.deepEqual(parseCommand("#cwd productv4-web"), { kind: "set-cwd", arg: "productv4-web" });
});

test("parseCommand: 普通消息不触发命令", () => {
  for (const text of ["帮我看看这个", "你好", "总结一下README", "切换一下浏览器标签页", "工作区的情况怎么样", "#other xxx"]) {
    assert.equal(parseCommand(text), null, `input: ${text}`);
  }
});

test("parseCommand: 空串不触发", () => {
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand("   "), null);
});

// ── resolveTargetDir ──────────────────────────────────────────────────────

const fakeFs = { realpathSync, statSync };

test("resolveTargetDir: 绝对路径存在则返回规范化路径", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  const target = join(dir, "proj");
  mkdirSync(target);
  const result = await resolveTargetDir(target, "/", undefined, fakeFs);
  assert.equal(result, realpathSync(target));
});

test("resolveTargetDir: 相对路径相对 baseCwd 解析", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  mkdirSync(join(dir, "sub"));
  const result = await resolveTargetDir("sub", dir, undefined, fakeFs);
  assert.equal(result, realpathSync(join(dir, "sub")));
});

test("resolveTargetDir: 不存在的路径返回 Error", async () => {
  const result = await resolveTargetDir("/nonexistent/definitely-missing-12345", "/", undefined, fakeFs);
  assert.ok(result instanceof Error);
  assert.match(result.message, /目录不可用/);
});

test("resolveTargetDir: 文件而非目录返回 Error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  const file = join(dir, "a.txt");
  writeFileSync(file, "x");
  const result = await resolveTargetDir(file, "/", undefined, fakeFs);
  assert.ok(result instanceof Error);
  assert.match(result.message, /不是目录/);
});

test("resolveTargetDir: 按已注册工作区标题匹配", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  const registry = {
    list: () => [
      { path: join(dir, "proj-a"), title: "proj-a", status: () => "ok" },
      { path: join(dir, "proj-b"), title: "proj-b", status: () => "ok" },
    ],
  };
  const result = await resolveTargetDir("proj-b", "/", registry, fakeFs);
  assert.equal(result, join(dir, "proj-b"));
});

test("resolveTargetDir: 标题前缀唯一匹配", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  const registry = {
    list: () => [
      { path: join(dir, "productv4-web"), title: "productv4-web", status: () => "ok" },
      { path: join(dir, "bp_product_web"), title: "bp_product_web", status: () => "ok" },
    ],
  };
  const result = await resolveTargetDir("product", "/", registry, fakeFs);
  assert.equal(result, join(dir, "productv4-web"));
});

test("resolveTargetDir: 标题多匹配返回 Error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  const registry = {
    list: () => [
      { path: join(dir, "ab"), title: "ab", status: () => "ok" },
      { path: join(dir, "abc"), title: "abc", status: () => "ok" },
    ],
  };
  const result = await resolveTargetDir("a", "/", registry, fakeFs);
  assert.ok(result instanceof Error);
  assert.match(result.message, /匹配到多个/);
});

test("resolveTargetDir: 已注册但目录缺失时返回 Error", async () => {
  const registry = {
    list: () => [{ path: "/gone/missing", title: "gone", status: () => "missing-dir" }],
  };
  const result = await resolveTargetDir("gone", "/", registry, fakeFs);
  assert.ok(result instanceof Error);
  assert.match(result.message, /已不存在/);
});

test("resolveTargetDir: 空参数返回 Error", async () => {
  const result = await resolveTargetDir("   ", "/", undefined, fakeFs);
  assert.ok(result instanceof Error);
  assert.match(result.message, /缺少目标目录参数/);
});

// ── formatWorkspaceList ───────────────────────────────────────────────────

test("formatWorkspaceList: 包含工作区路径与当前目录", () => {
  const rows = [
    { path: "/a/plug", title: "plug", status: () => "ok" },
    { path: "/b/gone", title: "gone", status: () => "missing-dir" },
  ];
  const text = formatWorkspaceList(rows, "/a/plug");
  assert.match(text, /已注册工作区（2 个）/);
  assert.match(text, /\/a\/plug/);
  assert.match(text, /\/b\/gone/);
  assert.match(text, /⚠️ 目录缺失/);
  assert.match(text, /当前工作目录：\/a\/plug/);
});

test("formatWorkspaceList: 空列表", () => {
  const text = formatWorkspaceList([], "/");
  assert.match(text, /已注册工作区（0 个）/);
  assert.match(text, /暂无/);
});

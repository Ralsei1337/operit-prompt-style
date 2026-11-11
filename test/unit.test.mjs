import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 离线单元测试：在 Node 里用假的 ToolPkg / Tools 运行时加载 dist/main.js，
 * 验证三个钩子的语义、幂等性、失败回退与 /style 命令。
 *
 * 不连真机、不导入 .toolpkg。运行：node test/unit.test.mjs
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const distMain = path.resolve(here, "../dist/main.js");

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS  " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("FAIL  " + name + "  — " + (error?.message ?? String(error)));
  }
}

/* ---------------- 假运行时 ---------------- */

const files = new Map();
const dirs = new Set();
let failNextRead = false;

const fakeFiles = {
  async exists(p) {
    return { path: p, exists: files.has(p) || dirs.has(p), isDirectory: dirs.has(p), size: 0, toString: () => p };
  },
  async read(p) {
    if (failNextRead) {
      failNextRead = false;
      throw new Error("simulated filesystem failure");
    }
    if (!files.has(p)) throw new Error("ENOENT " + p);
    const content = files.get(p);
    return { path: p, content, size: content.length, toString: () => p };
  },
  async write(p, content) {
    files.set(p, content);
    return { operation: { path: p, successful: true }, aiDiffInstructions: "", toString: () => p };
  },
  async mkdir(p) {
    dirs.add(p);
    return { path: p, successful: true, toString: () => p };
  },
  async deleteFile(p) {
    files.delete(p);
    return { path: p, successful: true, toString: () => p };
  },
  async list(p) {
    const entries = [];
    for (const key of files.keys()) {
      if (path.posix.dirname(key) === p) {
        entries.push({ name: path.posix.basename(key), isDirectory: false, size: 0, permissions: "rw", lastModified: "" });
      }
    }
    return { path: p, entries, toString: () => p };
  },
};

globalThis.Tools = { Files: fakeFiles };

const registered = { hooks: [], commands: [] };

globalThis.ToolPkg = {
  getConfigDir: () => "/vfs/plugins/com.operit.prompt_style",
  getSpaceDataDir: () => "/vfs/plugins/com.operit.prompt_style",
  registerSystemPromptComposeHook: (def) => registered.hooks.push({ kind: "system", def }),
  registerToolPromptComposeHook: (def) => registered.hooks.push({ kind: "toolPrompt", def }),
  registerToolLifecycleHook: (def) => registered.hooks.push({ kind: "lifecycle", def }),
  registerCoreCommand: (def) => registered.commands.push(def),
};

const style = require(distMain);

/* ---------------- 注册 ---------------- */

await check("registerToolPkg 返回 true 并注册 3 钩子 1 命令", () => {
  assert.equal(style.registerToolPkg(), true);
  assert.equal(registered.hooks.length, 3);
  assert.equal(registered.commands.length, 1);
  assert.equal(registered.commands[0].name, "style");
});

await check("registerToolPkg 可重复调用不抛错", () => {
  assert.equal(style.registerToolPkg(), true);
});

await check("test_connection 返回版本号", () => {
  const result = style.test_connection();
  assert.equal(result.passed, true);
  assert.equal(typeof result.version, "string");
});

/* ---------------- 注入 ---------------- */

await check("总开关关闭时系统提示词钩子返回 null", async () => {
  const result = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: "base prompt" },
  });
  assert.equal(result, null);
});

files.set("/vfs/plugins/com.operit.prompt_style/style-profile.json", JSON.stringify({ enabled: true }));

await check("非最终阶段返回 null", async () => {
  const result = await style.onSystemPromptCompose({
    eventName: "before_compose_system_prompt",
    eventPayload: { systemPrompt: "base prompt" },
  });
  assert.equal(result, null);
});

await check("注入规范段且保留原文", async () => {
  const result = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: "你是 Operit，一个全能 AI 助手。" },
  });
  assert.ok(result && typeof result.systemPrompt === "string");
  assert.ok(result.systemPrompt.startsWith("你是 Operit"), "原文正文未被保留");
  assert.ok(result.systemPrompt.includes("prompt-style-assistant:profile"), "标记缺失");
  assert.ok(result.systemPrompt.includes("结论先行"), "核心规则缺失");
  assert.ok(result.systemPrompt.includes("Response conventions"), "英文对照缺失");
});

await check("重复 compose 不叠段（幂等）", async () => {
  const once = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: "base" },
  });
  assert.ok(once && typeof once.systemPrompt === "string", "首次应用应产生改写");
  const twice = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: once.systemPrompt },
  });
  const finalText = twice === null ? once.systemPrompt : twice.systemPrompt;
  assert.equal((finalText.match(/prompt-style-assistant:profile/g) ?? []).length, 1, "第二次不应再叠段");
});

await check("三档风格的正文长度递增", async () => {
  const outputs = {};
  for (const mode of ["concise", "detailed"]) {
    const settings = await style.loadSettings();
    settings.profile.customSection = "";
    settings.profile.mode = mode;
    settings.enabled = true;
    await style.saveSettings(settings);
    const result = await style.onSystemPromptCompose({
      eventName: "after_compose_system_prompt",
      eventPayload: { systemPrompt: "x" },
    });
    outputs[mode] = result.systemPrompt.length;
  }
  // 平衡档介于两者之间：精简有裁剪，详尽有补充。
  const balanced = await style.onStyleCommand({ eventPayload: { args: ["mode", "balanced"] } });
  assert.equal(balanced.json.mode, "balanced");
  const mid = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: "x" },
  });
  assert.ok(outputs.concise < mid.systemPrompt.length, "精简档应短于平衡档");
  assert.ok(mid.systemPrompt.length < outputs.detailed, "详尽档应长于平衡档");
});

await check("预览模式只记录长度不改写", async () => {
  const settings = await style.loadSettings();
  settings.profile.previewOnly = true;
  settings.enabled = true;
  await style.saveSettings(settings);
  const result = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: "base" },
  });
  assert.equal(result, null, "预览模式不应改写");
  const status = await style.buildStatus();
  assert.ok(status.profile.lastProfileChars > 0, "预览模式应记录长度");
  settings.profile.previewOnly = false;
  await style.saveSettings(settings);
});

await check("自定义正文优先于内置正文", async () => {
  const settings = await style.loadSettings();
  settings.profile.customSection = "只回一句结论。";
  await style.saveSettings(settings);
  const result = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: "base" },
  });
  assert.ok(result.systemPrompt.includes("只回一句结论"));
  assert.ok(!result.systemPrompt.includes("Response conventions"), "不应混入内置正文");
  settings.profile.customSection = "";
  await style.saveSettings(settings);
});

/* ---------------- 工具清单 ---------------- */

await check("工具过滤：前缀通配符生效", async () => {
  const settings = await style.loadSettings();
  settings.tools.hidePatterns = ["browser_*", "run_code"];
  await style.saveSettings(settings);
  const result = await style.onToolPromptCompose({
    eventName: "filter_tool_prompt_items",
    eventPayload: {
      availableTools: [{ name: "browser_click" }, { name: "run_code" }, { name: "read_file" }],
    },
  });
  assert.deepEqual(result.availableTools.map((item) => item.name), ["read_file"]);
});

await check("工具过滤：无规则时不干预", async () => {
  const settings = await style.loadSettings();
  settings.tools.hidePatterns = [];
  await style.saveSettings(settings);
  const result = await style.onToolPromptCompose({
    eventName: "filter_tool_prompt_items",
    eventPayload: { availableTools: [{ name: "read_file" }] },
  });
  assert.equal(result, null);
});

await check("工具过滤：两个阶段都挂上", async () => {
  const settings = await style.loadSettings();
  settings.tools.hidePatterns = ["run_code"];
  await style.saveSettings(settings);
  const result = await style.onToolPromptCompose({
    eventName: "filter_tool_call_tools",
    eventPayload: { availableTools: [{ name: "run_code" }, { name: "read_file" }] },
  });
  assert.deepEqual(result.availableTools.map((item) => item.name), ["read_file"]);
  settings.tools.hidePatterns = [];
  await style.saveSettings(settings);
});

/* ---------------- 审计 ---------------- */

await check("生命周期钩子从不返回 allow/block", async () => {
  const result = await style.onToolLifecycle({
    eventName: "tool_call_requested",
    eventPayload: { toolName: "read_file", runtimeContext: null },
  });
  assert.equal(result, undefined, "只审计，不应给出决策");
});

await check("审计写入 jsonl", async () => {
  const lines = await style.readAudit(10);
  assert.ok(lines.length >= 1);
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.tool, "read_file");
});

/* ---------------- 快照 ---------------- */

await check("快照与回滚", async () => {
  const settings = await style.loadSettings();
  settings.tools.hidePatterns = ["snap_me"];
  await style.saveSettings(settings);
  settings.tools.hidePatterns = ["changed"];
  await style.saveSettings(settings);
  const result = await style.revertSettings();
  assert.equal(result.ok, true);
  assert.deepEqual((await style.loadSettings()).tools.hidePatterns, ["snap_me"]);
});

await check("快照数量受 keep 限制", async () => {
  const settings = await style.loadSettings();
  settings.snapshots.keep = 3;
  await style.saveSettings(settings);
  for (let i = 0; i < 6; i += 1) await style.saveSettings(settings);
  const listing = await fakeFiles.list("/vfs/plugins/com.operit.prompt_style/snapshots");
  assert.ok(listing.entries.length <= 3, "快照未被裁剪：" + listing.entries.length);
});

/* ---------------- 容错 ---------------- */

await check("文件系统故障时钩子返回 null 而不抛错", async () => {
  failNextRead = true;
  const result = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: "whatever" },
  });
  assert.equal(result, null);
});

/* ---------------- 命令 ---------------- */

await check("/style status 输出可解析 JSON", async () => {
  const result = await style.onStyleCommand({ eventPayload: { commandId: "style_command", commandName: "style", args: ["status"], json: false } });
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.enabled, "boolean");
  assert.equal(parsed.hooks.systemPromptCompose, "ok");
  assert.ok(["balanced", "concise", "detailed"].includes(parsed.profile.mode));
});

await check("/style on|off 切换总开关", async () => {
  await style.onStyleCommand({ eventPayload: { args: ["off"] } });
  assert.equal((await style.loadSettings()).enabled, false);
  await style.onStyleCommand({ eventPayload: { args: ["on"] } });
  assert.equal((await style.loadSettings()).enabled, true);
});

await check("/style mode 切换档位并自动启用", async () => {
  await style.onStyleCommand({ eventPayload: { args: ["off"] } });
  const result = await style.onStyleCommand({ eventPayload: { args: ["mode", "concise"] } });
  assert.equal(result.json.mode, "concise");
  const settings = await style.loadSettings();
  assert.equal(settings.profile.mode, "concise");
  assert.equal(settings.enabled, true, "切档位应自动启用");
});

await check("/style mode 非法值被拒绝", async () => {
  const result = await style.onStyleCommand({ eventPayload: { args: ["mode", "nope"] } });
  assert.ok(typeof result.stderr === "string" && result.stderr.includes("balanced"));
});

await check("/style hide 累积规则，unhide 移除", async () => {
  const base = await style.loadSettings();
  base.tools.hidePatterns = [];
  await style.saveSettings(base);
  await style.onStyleCommand({ eventPayload: { args: ["hide", "browser_*", "run_code"] } });
  assert.deepEqual([...(await style.loadSettings()).tools.hidePatterns].sort(), ["browser_*", "run_code"]);
  await style.onStyleCommand({ eventPayload: { args: ["unhide", "run_code"] } });
  assert.deepEqual((await style.loadSettings()).tools.hidePatterns, ["browser_*"]);
});

await check("/style 未知子命令返回 stderr 与用法", async () => {
  const result = await style.onStyleCommand({ eventPayload: { args: ["nope"] } });
  assert.ok(typeof result.stderr === "string" && result.stderr.includes("用法"));
});

/* ---------------- 边界 ---------------- */

await check("规范正文不涉及角色设定与内容取向", async () => {
  const result = await style.onSystemPromptCompose({
    eventName: "after_compose_system_prompt",
    eventPayload: { systemPrompt: "x" },
  });
  const text = result.systemPrompt;
  for (const banned of ["人设", "性格", "审查", "拒绝", "敏感"]) {
    assert.ok(!text.includes(banned), "正文不应涉及：" + banned);
  }
  assert.ok(text.includes("与角色设定、语气、内容取向无关"));
});

/* ---------------- 汇总 ---------------- */

console.log("\n" + passed + "/" + (passed + failures.length) + " passed");
if (failures.length > 0) {
  for (const failure of failures) console.error("\n[" + failure.name + "]\n" + failure.error?.stack);
  process.exit(1);
}

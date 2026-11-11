/// <reference path="../types/index.d.ts" />

/**
 * 提示词风格助手（Prompt Style Assistant）。
 *
 * 在会话组装系统提示词时追加一段**输出格式约定**，让助手的回复结构保持稳定：
 * 结论先行、不写开场套话、篇幅贴合复杂度、缺信息用占位符继续、工具失败换路子、
 * 长任务给阶段性结论、区分已确认与未验证。
 *
 * 三段式结构：
 *   1. 注入（profile）—— 按输出档位拼装规范文本，带标记、幂等；
 *   2. 裁剪（filter）—— 按需收敛模型可见的工具清单，减少无关调用；
 *   3. 诊断（diagnostics）—— 工具调用审计、配置快照与回滚。
 *
 * 设计约束：只改输出格式，不改宿主权限、不干预确认流程、不伪造工具结果。
 * 详见 docs/DESIGN.md 与 docs/RUNTIME-FACTS.md。
 */

/* ========================================================================
 * 1. 常量
 * ===================================================================== */

const PLUGIN_VERSION = "1.0.0";
const SETTINGS_FILE = "style-profile.json";
const SNAPSHOT_DIR = "snapshots";
const AUDIT_FILE = "tool-audit.jsonl";

/** 注入段的去重标记。重复 compose 时据此判断是否已注入。 */
const SECTION_MARKER = "<!-- prompt-style-assistant:profile -->";

const HOOK_SYSTEM_PROMPT = "style.system_prompt_compose";
const HOOK_TOOL_PROMPT = "style.tool_prompt_compose";
const HOOK_TOOL_LIFECYCLE = "style.tool_audit";
const COMMAND_ID = "style_command";

/* ========================================================================
 * 2. 输出档位与规范正文
 * ===================================================================== */

/** 输出档位。 */
type StyleMode = "balanced" | "concise" | "detailed";

interface StyleModeMeta {
  id: StyleMode;
  label: { zh: string; en: string };
}

const STYLE_MODES: StyleModeMeta[] = [
  { id: "balanced", label: { zh: "平衡（推荐）", en: "Balanced (recommended)" } },
  { id: "concise", label: { zh: "精简", en: "Concise" } },
  { id: "detailed", label: { zh: "详尽", en: "Detailed" } },
];

/** 校验档位标识，非法值回落平衡档。 */
function normalizeMode(value: unknown): StyleMode {
  return value === "concise" || value === "detailed" ? value : "balanced";
}

/** 规范正文的核心条目：中文说明 + 英文对照。 */
const PROFILE_RULES: string[][] = [
  [
    "结论先行：第一段给出结果本身（结论、代码、文件名、命令），说明放在其后。",
    "Lead with the result: the first paragraph carries the outcome itself; explanation follows.",
  ],
  [
    "不写开场套话：不复述用户的问题，不写「我理解你的需求」「这是一个好问题」之类的过场。",
    "No preamble: do not restate the question or open with acknowledgement filler.",
  ],
  [
    "篇幅贴合复杂度：一句话能答完的不写三段；需要步骤的地方给出可执行的编号步骤。",
    "Match length to complexity: a one-line answer stays one line; procedural work gets numbered steps.",
  ],
  [
    "信息缺口用占位符标注（如 [TARGET]、[PATH]、[TOKEN]）并继续推进，而不是停下来等。",
    "Fill gaps with explicit placeholders ([TARGET], [PATH], [TOKEN]) and keep going instead of stopping to ask.",
  ],
  [
    "工具调用失败时换一条实现路径继续（换参数、换命令、换接口），不在同一处重复同一失败调用。",
    "On a failed tool call, switch implementation path (parameters, command, endpoint) instead of repeating the same failing call.",
  ],
  [
    "长任务给阶段性结论，让读者在中途就能判断方向是否正确。",
    "For long tasks, post checkpoint conclusions so the reader can judge direction early.",
  ],
  [
    "区分已确认与未验证：写「已确认」的必须是实际运行或读到过的证据，推测要标「未验证」。",
    "Separate confirmed from unverified: only claim confirmed when it was actually run or read; label inference as unverified.",
  ],
];

/** 精简档的附加条目。 */
const PROFILE_RULES_CONCISE: string[] = [
  "精简档：默认不展开原理，只在用户追问或结论依赖原理时补充。",
  "Concise mode: omit background unless asked or unless the conclusion depends on it.",
];

/** 详尽档的附加条目。 */
const PROFILE_RULES_DETAILED: string[] = [
  "详尽档：给出取舍理由与边界条件，说明为什么这样做而不是另一种做法。",
  "详尽档：给出验证方式，让读者能自己复现「已确认」的结论。",
  "详尽档：涉及取舍时列出被放弃的方案及放弃原因。",
  "Detailed mode: include tradeoffs and boundary conditions, explaining why this approach over the alternative.",
  "Detailed mode: state how to verify, so the reader can reproduce every confirmed claim.",
  "Detailed mode: when a choice was made, list the rejected options and why they were dropped.",
];

/**
 * 生成规范正文。
 *
 * @param mode 输出档位
 * @param marker 去重标记
 */
function buildProfileSection(mode: StyleMode, marker: string): string {
  const lines: string[] = [marker, "## 输出规范 / Response conventions", ""];
  for (const pair of PROFILE_RULES) {
    lines.push("- " + pair[0]);
    // 精简档只要中文条目，省掉英文对照，进一步压缩上下文占用。
    if (mode !== "concise") lines.push("  " + pair[1]);
  }
  if (mode === "concise") for (const line of PROFILE_RULES_CONCISE) lines.push("- " + line);
  if (mode === "detailed") for (const line of PROFILE_RULES_DETAILED) lines.push("- " + line);
  lines.push("");
  lines.push("以上为输出格式约定，与角色设定、语气、内容取向无关。");
  if (mode !== "concise") {
    lines.push("These are output-format conventions only; character, tone, and subject matter are governed elsewhere.");
  }
  return lines.join("\n");
}

/* ========================================================================
 * 2. 设置模型
 * ===================================================================== */

export interface StyleSettings {
  schemaVersion: number;
  /** 总开关。关闭时三个钩子全部空转。 */
  enabled: boolean;
  profile: {
    /** 是否追加输出规范段。 */
    enabled: boolean;
    /** 输出档位：balanced / concise / detailed。 */
    mode: StyleMode;
    /** 自定义规范正文；空串表示使用内置正文。 */
    customSection: string;
    /** 预览模式：只记录将要注入的长度，不真正改写提示词。 */
    previewOnly: boolean;
  };
  tools: {
    /** 从模型可见工具清单里剔除的名称或前缀模式（支持结尾 *）。 */
    hidePatterns: string[];
  };
  audit: {
    /** 记录工具调用审计（tool_call_requested / tool_execution_result）。 */
    enabled: boolean;
    /** 审计文件保留的最大行数。 */
    maxLines: number;
  };
  snapshots: {
    /** 保存设置时保留的历史快照份数。 */
    keep: number;
  };
}

const DEFAULT_SETTINGS: StyleSettings = {
  schemaVersion: 1,
  enabled: false,
  profile: {
    enabled: true,
    mode: "balanced",
    customSection: "",
    previewOnly: false,
  },
  tools: {
    hidePatterns: [],
  },
  audit: {
    enabled: true,
    maxLines: 400,
  },
  snapshots: {
    keep: 20,
  },
};

/* ========================================================================
 * 3. 路径与文件辅助
 * ===================================================================== */

function configDir(): string {
  return ToolPkg.getConfigDir();
}

function settingsPath(): string {
  return configDir() + "/" + SETTINGS_FILE;
}

function snapshotDir(): string {
  return configDir() + "/" + SNAPSHOT_DIR;
}

function auditPath(): string {
  return configDir() + "/" + AUDIT_FILE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深合并：只接受与默认值同类型的字段，脏数据一律回落默认。 */
function mergeSettings(base: StyleSettings, patch: unknown): StyleSettings {
  if (!isRecord(patch)) return base;
  const out: StyleSettings = JSON.parse(JSON.stringify(base)) as StyleSettings;
  if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
  if (typeof patch.schemaVersion === "number") out.schemaVersion = patch.schemaVersion;

  const profile = patch.profile;
  if (isRecord(profile)) {
    if (typeof profile.enabled === "boolean") out.profile.enabled = profile.enabled;
    if (typeof profile.mode === "string") out.profile.mode = normalizeMode(profile.mode);
    if (typeof profile.customSection === "string") out.profile.customSection = profile.customSection;
    if (typeof profile.previewOnly === "boolean") out.profile.previewOnly = profile.previewOnly;
  }

  const tools = patch.tools;
  if (isRecord(tools) && Array.isArray(tools.hidePatterns)) {
    out.tools.hidePatterns = tools.hidePatterns
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => item.trim());
  }

  const audit = patch.audit;
  if (isRecord(audit)) {
    if (typeof audit.enabled === "boolean") out.audit.enabled = audit.enabled;
    if (typeof audit.maxLines === "number" && Number.isFinite(audit.maxLines)) {
      out.audit.maxLines = Math.max(20, Math.min(5000, Math.floor(audit.maxLines)));
    }
  }

  const snapshots = patch.snapshots;
  if (isRecord(snapshots) && typeof snapshots.keep === "number" && Number.isFinite(snapshots.keep)) {
    out.snapshots.keep = Math.max(1, Math.min(200, Math.floor(snapshots.keep)));
  }

  return out;
}

/** 读取设置。文件不存在或损坏时回落到默认值，不抛出。 */
export async function loadSettings(): Promise<StyleSettings> {
  try {
    const exists = await Tools.Files.exists(settingsPath());
    if (!exists.exists) return mergeSettings(DEFAULT_SETTINGS, null);
    const file = await Tools.Files.read(settingsPath());
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(file.content));
  } catch (error) {
    console.error("[style] loadSettings failed:", String(error));
    return mergeSettings(DEFAULT_SETTINGS, null);
  }
}

/** 写设置。写盘前先给旧值留一份快照。 */
export async function saveSettings(next: StyleSettings): Promise<void> {
  const merged = mergeSettings(DEFAULT_SETTINGS, next);
  try {
    const exists = await Tools.Files.exists(settingsPath());
    if (exists.exists) {
      const previous = await Tools.Files.read(settingsPath());
      await snapshotSettings(previous.content);
    }
  } catch (error) {
    console.error("[style] snapshot before save failed:", String(error));
  }
  await Tools.Files.mkdir(configDir(), true);
  await Tools.Files.write(settingsPath(), JSON.stringify(merged, null, 2), false);
  await pruneSnapshots(merged.snapshots.keep);
}

/* ========================================================================
 * 4. 快照
 * ===================================================================== */

async function snapshotSettings(content: string): Promise<string> {
  await Tools.Files.mkdir(snapshotDir(), true);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = snapshotDir() + "/" + stamp + ".json";
  await Tools.Files.write(path, content, false);
  return path;
}

async function listSnapshots(): Promise<string[]> {
  try {
    const listing = await Tools.Files.list(snapshotDir());
    const names = listing.entries
      .filter((entry) => entry.isDirectory === false && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
    return names.sort();
  } catch {
    return [];
  }
}

async function pruneSnapshots(keep: number): Promise<void> {
  const names = await listSnapshots();
  if (names.length <= keep) return;
  for (const name of names.slice(0, names.length - keep)) {
    try {
      await Tools.Files.deleteFile(snapshotDir() + "/" + name);
    } catch (error) {
      console.error("[style] prune failed:", String(error));
    }
  }
}

/** 回滚到指定快照（不指定则回滚到最新一份）。 */
export async function revertSettings(name?: string): Promise<{ ok: boolean; restored: string | null }> {
  const names = await listSnapshots();
  if (names.length === 0) return { ok: false, restored: null };
  const target = name && names.includes(name) ? name : names[names.length - 1];
  const file = await Tools.Files.read(snapshotDir() + "/" + target);
  const restored = mergeSettings(DEFAULT_SETTINGS, JSON.parse(file.content));
  await Tools.Files.write(settingsPath(), JSON.stringify(restored, null, 2), false);
  return { ok: true, restored: target };
}

/* ========================================================================
 * 6. 输出规范段
 * ===================================================================== */

/** 取当前设置对应的规范正文；自定义正文优先。 */
function sectionText(settings: StyleSettings): string {
  const custom = settings.profile.customSection.trim();
  if (custom !== "") {
    return custom.includes(SECTION_MARKER) ? custom : SECTION_MARKER + "\n" + custom;
  }
  return buildProfileSection(settings.profile.mode, SECTION_MARKER);
}

/** 幂等追加：已含标记就不重复注入。 */
export function appendSection(prompt: string, section: string): string {
  if (typeof prompt !== "string") return prompt;
  if (prompt.includes(SECTION_MARKER)) return prompt;
  const trimmed = prompt.replace(/\s+$/, "");
  return trimmed === "" ? section : trimmed + "\n\n" + section;
}

/* ========================================================================
 * 7. 工具清单过滤
 * ===================================================================== */

/** 支持结尾通配符的模式匹配。 */
export function matchesPattern(name: string, pattern: string): boolean {
  if (typeof name !== "string" || typeof pattern !== "string") return false;
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  if (trimmed.endsWith("*")) {
    return name.startsWith(trimmed.slice(0, -1));
  }
  return name === trimmed;
}

export function shouldHide(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(name, pattern));
}

/* ========================================================================
 * 8. 审计
 * ===================================================================== */

interface AuditEntry {
  at: string;
  kind: string;
  tool?: string;
  ok?: boolean;
  error?: string;
}

/** 追加一条审计记录，超过上限时整体截断到后半段。 */
async function appendAudit(entry: AuditEntry): Promise<void> {
  try {
    await Tools.Files.mkdir(configDir(), true);
    const settings = await loadSettings();
    const line = JSON.stringify(entry) + "\n";
    const exists = await Tools.Files.exists(auditPath());
    if (!exists.exists) {
      await Tools.Files.write(auditPath(), line, false);
      return;
    }
    const file = await Tools.Files.read(auditPath());
    const lines = file.content.split("\n").filter((item) => item.trim() !== "");
    const limit = Math.max(20, Math.min(5000, settings.audit.maxLines));
    if (lines.length >= limit) {
      const kept = lines.slice(lines.length - Math.floor(limit / 2) + 1);
      await Tools.Files.write(auditPath(), kept.join("\n") + "\n" + line, false);
      return;
    }
    await Tools.Files.write(auditPath(), line, true);
  } catch (error) {
    console.error("[style] appendAudit failed:", String(error));
  }
}

/** 读取最近的审计记录（新的在后）。 */
export async function readAudit(limit = 50): Promise<string[]> {
  try {
    const file = await Tools.Files.read(auditPath());
    const lines = file.content.split("\n").filter((item) => item.trim() !== "");
    return lines.slice(Math.max(0, lines.length - limit));
  } catch {
    return [];
  }
}

/* ========================================================================
 * 9. 钩子
 * ===================================================================== */

/** 每个钩子的注册结果，供自检使用。 */
const registrationState: Record<string, string> = {};

/** 运行期计数，供状态页展示。 */
const runtimeCounters = {
  systemPromptCalls: 0,
  profileInjected: 0,
  toolPromptCalls: 0,
  toolPromptFiltered: 0,
  lifecycleCalls: 0,
  lastProfileChars: 0,
  lastError: "" as string,
};

function stageOf(event: { eventName: string }, payload: { stage?: string }): string {
  const stage = payload.stage;
  return stage === undefined || stage === "" ? event.eventName : stage;
}

/**
 * 系统提示词组合钩子。
 *
 * 在 after_compose_system_prompt 阶段，把输出规范段追加到 payload.systemPrompt。
 * 返回值会**整体替换**该阶段的值，所以必须基于原串拼接，不能凭空造串。
 * 已含标记时直接返回 null，保证幂等。
 */
export async function onSystemPromptCompose(
  event: ToolPkg.SystemPromptComposeHookEvent
): Promise<ToolPkg.PromptHookObjectResult | null> {
  try {
    runtimeCounters.systemPromptCalls += 1;
    const payload = event.eventPayload;
    if (stageOf(event, payload) !== "after_compose_system_prompt") return null;

    const settings = await loadSettings();
    if (!settings.enabled) return null;

    const current = payload.systemPrompt;
    if (typeof current !== "string" || current === "") return null;

    const section = sectionText(settings);
    if (section === "") return null;

    if (settings.profile.previewOnly) {
      runtimeCounters.lastProfileChars = section.length;
      return null;
    }

    const next = appendSection(current, section);
    if (next === current) return null;
    runtimeCounters.profileInjected += 1;
    runtimeCounters.lastProfileChars = section.length;
    return { systemPrompt: next };
  } catch (error) {
    runtimeCounters.lastError = "system_prompt: " + String(error);
    console.error("[style] onSystemPromptCompose failed:", String(error));
    return null;
  }
}

/**
 * 工具提示词组合钩子。
 *
 * 在两个过滤阶段按 hidePatterns 剔除工具。返回的 availableTools 是**整份清单**，
 * 所以必须基于 payload.availableTools 过滤后返回，不能返回增量。
 */
export async function onToolPromptCompose(
  event: ToolPkg.ToolPromptComposeHookEvent
): Promise<ToolPkg.PromptHookObjectResult | null> {
  try {
    runtimeCounters.toolPromptCalls += 1;
    const payload = event.eventPayload;
    const stage = stageOf(event, payload);
    if (stage !== "filter_tool_prompt_items" && stage !== "filter_tool_call_tools") return null;

    const settings = await loadSettings();
    if (!settings.enabled) return null;

    const available = payload.availableTools;
    if (!Array.isArray(available)) return null;
    const patterns = settings.tools.hidePatterns;
    if (patterns.length === 0) return null;

    const filtered = available.filter((item) => {
      const name = isRecord(item) && typeof item.name === "string" ? item.name : "";
      return name === "" || !shouldHide(name, patterns);
    });

    if (filtered.length === available.length) return null;
    runtimeCounters.toolPromptFiltered += 1;
    return { availableTools: filtered };
  } catch (error) {
    runtimeCounters.lastError = "tool_prompt: " + String(error);
    console.error("[style] onToolPromptCompose failed:", String(error));
    return null;
  }
}

/**
 * 工具生命周期钩子 —— 只做审计，不做决策。
 *
 * 依据宿主机理（见 docs/RUNTIME-FACTS.md）：tool_call_intercept 的返回值
 * 只区分 block 与「继续」，返回 allow 与不返回在 Rust 侧完全等价；
 * 用户确认弹窗由宿主 AiPermissionMode 与权限系统在 intercept 之后执行。
 * 因此本钩子不返回任何 action，避免制造「已放行」的错觉。
 */
export async function onToolLifecycle(
  event: ToolPkg.ToolLifecycleHookEvent
): Promise<ToolPkg.ToolLifecycleHookReturnVariant3Output> {
  try {
    runtimeCounters.lifecycleCalls += 1;
    const payload = event.eventPayload;
    const stage = event.eventName;

    if (stage !== "tool_call_requested" && stage !== "tool_execution_result") return;

    const settings = await loadSettings();
    if (!settings.enabled || !settings.audit.enabled) return;

    if (stage === "tool_call_requested") {
      await appendAudit({ at: new Date().toISOString(), kind: "request", tool: payload.toolName });
    } else {
      await appendAudit({
        at: new Date().toISOString(),
        kind: "result",
        tool: payload.toolName,
        ok: payload.success === true,
        error: typeof payload.errorMessage === "string" ? payload.errorMessage.slice(0, 200) : undefined,
      });
    }
    return;
  } catch (error) {
    console.error("[style] onToolLifecycle failed:", String(error));
    return;
  }
}

/* ========================================================================
 * 10. 自检
 * ===================================================================== */

export async function buildStatus(): Promise<ToolPkg.JsonObject> {
  const settings = await loadSettings();
  const snapshots = await listSnapshots();
  let settingsReadable = false;
  let settingsProblem = "";
  try {
    await Tools.Files.read(settingsPath());
    settingsReadable = true;
  } catch {
    settingsProblem = "设置文件尚未创建（首次保存后生成）";
  }
  const audit = await readAudit(5);
  return {
    version: PLUGIN_VERSION,
    enabled: settings.enabled,
    settingsPath: settingsPath(),
    settingsReadable,
    settingsProblem: settingsProblem === "" ? null : settingsProblem,
    hooks: { ...registrationState },
    counters: { ...runtimeCounters },
    profile: {
      enabled: settings.profile.enabled,
      mode: settings.profile.mode,
      previewOnly: settings.profile.previewOnly,
      customSectionChars: settings.profile.customSection.length,
      lastProfileChars: runtimeCounters.lastProfileChars,
    },
    tools: { hidePatterns: settings.tools.hidePatterns },
    snapshots: { count: snapshots.length, latest: snapshots.length > 0 ? snapshots[snapshots.length - 1] : null },
    audit: { enabled: settings.audit.enabled, recent: audit },
  };
}

/* ========================================================================
 * 11. /style 命令
 * ===================================================================== */

function ok(stdout: string, json?: ToolPkg.JsonValue): ToolPkg.CoreCommandResult {
  return { stdout, json: json === undefined ? { ok: true } : json };
}

function fail(stdout: string, json?: ToolPkg.JsonValue): ToolPkg.CoreCommandResult {
  return { stdout, stderr: stdout, json: json === undefined ? { ok: false } : json };
}

const USAGE = [
  "用法：/style <子命令>",
  "  status               查看当前档位、注入状态与统计",
  "  on | off             启用 / 停用",
  "  mode balanced|concise|detailed   切换输出档位",
  "  hide <pattern...>    隐藏工具（支持结尾 *）",
  "  unhide <pattern...>  取消隐藏",
  "  preview on|off       预览模式：只记录将要注入的长度，不改写",
  "  snapshots            列出配置快照",
  "  revert [name]        回滚配置",
  "  audit [n]            查看最近工具调用审计",
  "  reset                重置为默认档位",
].join("\n");

export async function onStyleCommand(event: ToolPkg.CoreCommandHookEvent): Promise<ToolPkg.CoreCommandResult> {
  const args = event.eventPayload.args.map((arg) => arg.trim()).filter((arg) => arg !== "");
  const action = (args[0] ?? "status").toLowerCase();

  try {
    if (action === "status") {
      const status = await buildStatus();
      return ok(JSON.stringify(status, null, 2), status);
    }

    if (action === "on" || action === "off") {
      const settings = await loadSettings();
      settings.enabled = action === "on";
      await saveSettings(settings);
      return ok(`提示词风格助手已${action === "on" ? "启用" : "停用"}。`, { ok: true, enabled: settings.enabled });
    }

    if (action === "mode") {
      const requested = (args[1] ?? "").toLowerCase();
      if (!["balanced", "concise", "detailed"].includes(requested)) {
        return fail("用法：/style mode balanced|concise|detailed");
      }
      const settings = await loadSettings();
      settings.profile.mode = normalizeMode(requested);
      settings.enabled = true;
      await saveSettings(settings);
      const meta = STYLE_MODES.find((item) => item.id === settings.profile.mode);
      return ok(`输出档位：${meta?.label.zh ?? settings.profile.mode}`, {
        ok: true,
        mode: settings.profile.mode,
      });
    }

    if (action === "hide" || action === "unhide") {
      const patterns = args.slice(1);
      if (patterns.length === 0) return fail("用法：/style hide <工具名或前缀*> [...]");
      const settings = await loadSettings();
      if (action === "hide") {
        settings.tools.hidePatterns = [...new Set([...settings.tools.hidePatterns, ...patterns])];
      } else {
        settings.tools.hidePatterns = settings.tools.hidePatterns.filter((item) => !patterns.includes(item));
      }
      await saveSettings(settings);
      return ok(`当前隐藏规则：${settings.tools.hidePatterns.join(", ") || "(无)"}`, {
        ok: true,
        hidePatterns: settings.tools.hidePatterns,
      });
    }

    if (action === "preview") {
      const mode = (args[1] ?? "").toLowerCase();
      if (mode !== "on" && mode !== "off") return fail("用法：/style preview on|off");
      const settings = await loadSettings();
      settings.profile.previewOnly = mode === "on";
      await saveSettings(settings);
      return ok(
        `预览模式：${mode === "on" ? "开（只记录长度，不改写提示词）" : "关"}`,
        { ok: true, previewOnly: settings.profile.previewOnly }
      );
    }

    if (action === "snapshots") {
      const names = await listSnapshots();
      return ok(names.length === 0 ? "暂无快照。" : names.join("\n"), { ok: true, snapshots: names });
    }

    if (action === "revert") {
      const result = await revertSettings(args[1]);
      if (!result.ok) return fail("没有可回滚的快照。");
      return ok(`已回滚到 ${result.restored}`, { ok: true, restored: result.restored });
    }

    if (action === "audit") {
      const limit = Number(args[1] ?? "30");
      const lines = await readAudit(Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 30);
      return ok(lines.length === 0 ? "暂无审计记录。" : lines.join("\n"), { ok: true, entries: lines });
    }

    if (action === "reset") {
      await saveSettings(DEFAULT_SETTINGS);
      return ok("已重置为默认配置（旧值已留快照）。", { ok: true });
    }

    return fail(USAGE);
  } catch (error) {
    return fail("命令执行失败：" + String(error));
  }
}

/* ========================================================================
 * 12. 注册
 * ===================================================================== */

function registerSafely(key: string, action: () => void): void {
  try {
    action();
    registrationState[key] = "ok";
  } catch (error) {
    registrationState[key] = "failed: " + String(error);
    console.error("[style] register " + key + " failed:", String(error));
  }
}

export function registerToolPkg(): boolean {
  registerSafely("systemPromptCompose", () => {
    ToolPkg.registerSystemPromptComposeHook({ id: HOOK_SYSTEM_PROMPT, function: onSystemPromptCompose });
  });
  registerSafely("toolPromptCompose", () => {
    ToolPkg.registerToolPromptComposeHook({ id: HOOK_TOOL_PROMPT, function: onToolPromptCompose });
  });
  registerSafely("toolLifecycle", () => {
    ToolPkg.registerToolLifecycleHook({ id: HOOK_TOOL_LIFECYCLE, function: onToolLifecycle });
  });
  registerSafely("coreCommand", () => {
    ToolPkg.registerCoreCommand({
      id: COMMAND_ID,
      name: "style",
      title: { zh: "输出风格", en: "Response style" },
      description: {
        zh: "切换回复风格档位、管理工具可见性、回滚配置、查看工具调用审计。",
        en: "Switch the response style mode, manage tool visibility, roll back settings, and read the tool audit.",
      },
      usage: "/style [status|on|off|mode|hide|unhide|preview|snapshots|revert|audit|reset]",
      function: onStyleCommand,
    });
  });
  return true;
}

/** 连通性探针：证明主运行时确实执行了本包。 */
export function test_connection(): { passed: boolean; version: string } {
  return { passed: true, version: PLUGIN_VERSION };
}

/** 本包的可见入口是钩子与命令，没有业务工具。 */
export function test_tool_call(): { passed: boolean; message: string } {
  return { passed: false, message: "本插件注册提示词钩子与 /style 命令，没有独立业务工具。" };
}

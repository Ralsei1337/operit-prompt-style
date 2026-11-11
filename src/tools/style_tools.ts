/* METADATA
{
  "name": "style_tools",
  "display_name": {
    "zh": "输出风格设置",
    "en": "Response Style"
  },
  "description": {
    "zh": "输出风格的模型可见入口：查看当前档位、切换风格、读取工具调用审计、回滚配置快照。这些工具与 /style 命令读写同一份配置文件。",
    "en": "Model-facing entry points for response styling: inspect the current mode, switch styles, read the tool audit, and roll back configuration snapshots. These tools share the same config file as the /style command."
  },
  "enabledByDefault": false,
  "category": "Utility",
  "tools": [
    {
      "name": "style_status",
      "display": { "label": { "zh": "查看输出风格", "en": "Response style" }, "icon": "tune" },
      "description": {
        "zh": "读取当前风格配置、可用快照与最近审计记录。只读，不修改任何东西。",
        "en": "Reads the current style configuration, available snapshots, and recent audit entries. Read-only."
      },
      "parameters": []
    },
    {
      "name": "style_configure",
      "display": { "label": { "zh": "调整输出风格", "en": "Configure style" }, "icon": "settings" },
      "description": {
        "zh": "按需修改风格配置，只改传入的字段，其余保持不变。修改前会自动为旧配置留一份快照。",
        "en": "Updates style settings; only supplied fields change. The previous settings are snapshotted before writing."
      },
      "parameters": [
        {
          "name": "enabled",
          "description": { "zh": "总开关：true 启用输出风格，false 停用。", "en": "Master switch: true enables the profile injection." },
          "type": "boolean",
          "required": false
        },
        {
          "name": "mode",
          "description": { "zh": "输出档位：balanced（平衡）/ concise（精简）/ detailed（详尽）。", "en": "Response style mode: balanced, concise, or detailed." },
          "type": "string",
          "required": false
        },
        {
          "name": "hidePatterns",
          "description": {
            "zh": "从模型可见工具清单里剔除的工具名数组，支持结尾通配符，例如 [\"browser_*\",\"run_code\"]。传空数组表示全部恢复。",
            "en": "Tool names to hide from the model-facing tool list; a trailing * acts as a prefix wildcard. An empty array restores everything."
          },
          "type": "array",
          "required": false
        },
        {
          "name": "auditEnabled",
          "description": { "zh": "是否记录工具调用审计。", "en": "Whether to record tool-call audit entries." },
          "type": "boolean",
          "required": false
        }
      ]
    },
    {
      "name": "style_audit",
      "display": { "label": { "zh": "读取调用审计", "en": "Read call audit" }, "icon": "history" },
      "description": {
        "zh": "读取最近的工具调用审计记录（谁请求了什么、是否成功、错误摘要）。",
        "en": "Reads recent tool-call audit entries: what was requested, whether it succeeded, and an error summary."
      },
      "parameters": [
        {
          "name": "limit",
          "description": { "zh": "返回最近多少条，默认 30，上限 200。", "en": "How many recent entries to return; default 30, max 200." },
          "type": "number",
          "required": false
        }
      ]
    },
    {
      "name": "style_revert",
      "display": { "label": { "zh": "回滚风格配置", "en": "Roll back style" }, "icon": "restore" },
      "description": {
        "zh": "把风格配置回滚到某份快照。不指定快照名时回滚到最新一份。",
        "en": "Restores style settings from a snapshot. Without a name, the newest snapshot is used."
      },
      "parameters": [
        {
          "name": "snapshot",
          "description": { "zh": "快照文件名，例如 2026-11-11T09-30-00-000Z.json。省略则用最新一份。", "en": "Snapshot file name; omit for the newest one." },
          "type": "string",
          "required": false
        }
      ]
    }
  ]
}*/

/// <reference path="../../types/index.d.ts" />

/**
 * 输出风格工具子包。
 *
 * 与主入口是两个独立的 JS 运行时，因此这里不 require 主入口，而是复用同一份
 * 配置文件（ToolPkg.getConfigDir() 在安装所有者维度上对主入口与子包一致）。
 * 字段合并规则必须与 src/main.ts 的 mergeSettings 保持一致，改动时两边同改。
 */

const SETTINGS_FILE = "style-profile.json";
const SNAPSHOT_DIR = "snapshots";
const AUDIT_FILE = "tool-audit.jsonl";

interface StyleSettings {
  schemaVersion: number;
  enabled: boolean;
  profile: { enabled: boolean; mode: string; customSection: string; previewOnly: boolean };
  tools: { hidePatterns: string[] };
  audit: { enabled: boolean; maxLines: number };
  snapshots: { keep: number };
}

const DEFAULT_SETTINGS: StyleSettings = {
  schemaVersion: 1,
  enabled: false,
  profile: { enabled: true, mode: "balanced", customSection: "", previewOnly: false },
  tools: { hidePatterns: [] },
  audit: { enabled: true, maxLines: 400 },
  snapshots: { keep: 20 },
};

/** 校验档位标识，非法值回落平衡档。 */
function normalizeMode(value: unknown): string {
  return value === "concise" || value === "detailed" ? value : "balanced";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function mergeSettings(base: StyleSettings, patch: unknown): StyleSettings {
  if (!isRecord(patch)) return base;
  const out: StyleSettings = JSON.parse(JSON.stringify(base)) as StyleSettings;
  if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
  const profile = patch.profile;
  if (isRecord(profile)) {
    if (typeof profile.enabled === "boolean") out.profile.enabled = profile.enabled;
    if (typeof profile.customSection === "string") out.profile.customSection = profile.customSection;
    if (typeof profile.previewOnly === "boolean") out.profile.previewOnly = profile.previewOnly;
    if (profile.mode === "balanced" || profile.mode === "concise" || profile.mode === "detailed") {
      out.profile.mode = profile.mode;
    }
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

async function loadSettings(): Promise<StyleSettings> {
  try {
    const exists = await Tools.Files.exists(settingsPath());
    if (!exists.exists) return mergeSettings(DEFAULT_SETTINGS, null);
    const file = await Tools.Files.read(settingsPath());
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(file.content));
  } catch (error) {
    console.error("[style_tools] loadSettings failed:", String(error));
    return mergeSettings(DEFAULT_SETTINGS, null);
  }
}

async function snapshotCurrent(): Promise<string | null> {
  try {
    const exists = await Tools.Files.exists(settingsPath());
    if (!exists.exists) return null;
    const file = await Tools.Files.read(settingsPath());
    await Tools.Files.mkdir(snapshotDir(), true);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = snapshotDir() + "/" + stamp + ".json";
    await Tools.Files.write(path, file.content, false);
    return path;
  } catch (error) {
    console.error("[style_tools] snapshot failed:", String(error));
    return null;
  }
}

async function listSnapshots(): Promise<string[]> {
  try {
    const listing = await Tools.Files.list(snapshotDir());
    return listing.entries
      .filter((entry) => entry.isDirectory === false && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function saveSettings(next: StyleSettings): Promise<void> {
  const merged = mergeSettings(DEFAULT_SETTINGS, next);
  await Tools.Files.mkdir(configDir(), true);
  await Tools.Files.write(settingsPath(), JSON.stringify(merged, null, 2), false);
  const names = await listSnapshots();
  if (names.length > merged.snapshots.keep) {
    for (const name of names.slice(0, names.length - merged.snapshots.keep)) {
      try {
        await Tools.Files.deleteFile(snapshotDir() + "/" + name);
      } catch (error) {
        console.error("[style_tools] prune failed:", String(error));
      }
    }
  }
}

async function readAudit(limit: number): Promise<string[]> {
  try {
    const file = await Tools.Files.read(auditPath());
    const lines = file.content.split("\n").filter((item) => item.trim() !== "");
    return lines.slice(Math.max(0, lines.length - limit));
  } catch {
    return [];
  }
}

/** 读取当前风格配置、快照与最近审计。 */
async function style_status(): Promise<Record<string, unknown>> {
  const settings = await loadSettings();
  const snapshots = await listSnapshots();
  const audit = await readAudit(10);
  return {
    enabled: settings.enabled,
    profile: settings.profile,
    tools: settings.tools,
    audit: { enabled: settings.audit.enabled, maxLines: settings.audit.maxLines, recent: audit },
    snapshots: { keep: settings.snapshots.keep, count: snapshots.length, names: snapshots.slice(-10) },
    paths: { settings: settingsPath(), snapshots: snapshotDir(), audit: auditPath() },
  };
}

/** 部分更新配置；未传的字段保持不变。 */
async function style_configure(params: {
  enabled?: boolean;
  mode?: string;
  previewOnly?: boolean;
  hidePatterns?: unknown;
  auditEnabled?: boolean;
}): Promise<Record<string, unknown>> {
  const current = await loadSettings();
  const snapshot = await snapshotCurrent();

  const patch: Record<string, unknown> = { ...current };
  if (typeof params.enabled === "boolean") patch.enabled = params.enabled;

  const profile = { ...current.profile } as Record<string, unknown>;
  if (typeof params.mode === "string") profile.mode = normalizeMode(params.mode);
  if (typeof params.previewOnly === "boolean") profile.previewOnly = params.previewOnly;
  patch.profile = profile;

  const tools = { ...current.tools } as Record<string, unknown>;
  if (Array.isArray(params.hidePatterns)) {
    tools.hidePatterns = params.hidePatterns
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  patch.tools = tools;

  const audit = { ...current.audit } as Record<string, unknown>;
  if (typeof params.auditEnabled === "boolean") audit.enabled = params.auditEnabled;
  patch.audit = audit;

  const merged = mergeSettings(DEFAULT_SETTINGS, patch);
  await saveSettings(merged);
  return {
    applied: true,
    snapshotCreated: snapshot !== null,
    settings: merged,
  };
}

/** 读取最近审计记录。 */
async function style_audit(params: { limit?: number }): Promise<Record<string, unknown>> {
  const raw = Number(params.limit ?? 30);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 30;
  const entries = await readAudit(limit);
  return { count: entries.length, entries };
}

/** 回滚到指定或最新快照。 */
async function style_revert(params: { snapshot?: string }): Promise<Record<string, unknown>> {
  const names = await listSnapshots();
  if (names.length === 0) {
    return { applied: false, reason: "no snapshots available" };
  }
  const requested = typeof params.snapshot === "string" ? params.snapshot.trim() : "";
  const target = requested !== "" && names.includes(requested) ? requested : names[names.length - 1];
  const file = await Tools.Files.read(snapshotDir() + "/" + target);
  const restored = mergeSettings(DEFAULT_SETTINGS, JSON.parse(file.content));
  await Tools.Files.write(settingsPath(), JSON.stringify(restored, null, 2), false);
  return { applied: true, restoredFrom: target, settings: restored };
}

exports.style_status = style_status;
exports.style_configure = style_configure;
exports.style_audit = style_audit;
exports.style_revert = style_revert;

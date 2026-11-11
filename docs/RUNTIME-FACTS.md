# 宿主机理事实（对照 Operit2@main）

本文件记录本工程依赖的每一条 Operit2 行为，都带代码位置。改宿主大版本后按此表复核，
任意一条变了都可能让某个钩子失效。

## 1. 钩子注册面

`plugins/types/toolpkg.d.ts`

| 事实 | 位置 |
| --- | --- |
| `ToolPkg.registerSystemPromptComposeHook({ id, function })` | `toolpkg.d.ts:4251`（命名空间）/ `:4437`（全局别名） |
| `ToolPkg.registerToolPromptComposeHook` | `:4255` / `:4445` |
| `ToolPkg.registerToolLifecycleHook` | `:4235` / `:4441` |
| `ToolPkg.registerCoreCommand` | 同文件 `CoreCommandRegistration` @ `:3752` |

## 2. system prompt 钩子契约

`core/crates/runtime/application/src/plugins/toolpkg/ToolPkgPromptHookBridge.rs`

- 阶段枚举：`before_compose_system_prompt` / `compose_system_prompt_sections` / `after_compose_system_prompt`（`toolpkg.d.ts:889`）。
- payload 字段 `systemPrompt`（字符串）；返回对象里的 `systemPrompt` 会**整体替换**该阶段的当前值（`prompthook.rs` 的 `apply_prompt_mutation`：`if let Some(system_prompt) = mutation.system_prompt { current.system_prompt = Some(system_prompt); }`）。
- 多插件叠加：`dispatch_prompt_hooks` 按 `getEnabledToolPkgContainerRuntimes()` 顺序逐个调用，每个 hook 的返回值被 `apply_prompt_mutation` 写回 `current`，下一个 hook 看到的是上一个的结果。**所以必须基于 payload 改写，不能凭空造串。**
- 返回 `null` / `undefined` / 空串 → 视为不改动。

**本工程的应对**：`onSystemPromptCompose` 只接受 `after_compose_system_prompt`，基于 `payload.systemPrompt` 调 `appendSection` 追加规范段，无变化（已含标记）返回 `null`。

## 3. 工具清单钩子契约

同文件。

- 阶段：`filter_tool_prompt_items` / `filter_tool_call_tools`（`toolpkg.d.ts:894`）。
- payload `availableTools` 是**完整清单数组**；返回 `{ availableTools }` 是**整份替换**（`decode_tool_prompt_policy_result` 对 `availableTools` 做 `serde_json::from_value` 整体赋值）。
- 不返回或返回非数组 → 不改动。

**本工程的应对**：`onToolPromptCompose` 基于 `payload.availableTools` 过滤，条数没变就返回 `null`。

## 4. tool lifecycle：intercept 只能收紧

`core/crates/runtime/application/src/plugins/toolpkg/ToolPkgToolLifecycleBridge.rs` + `core/crates/tool/services/src/tools/AIToolHandler.rs`

```rust
// ToolPkgToolLifecycleBridge.rs:onToolCallInterceptAsync
for container in manager.getEnabledToolPkgContainerRuntimes() {
    for hook in container.toolLifecycleHooks {
        let decision = decode_intercept_result(raw)?;
        if let AIToolHookDecision::Block(_) = decision {
            return Ok(decision);      // 只有 block 会短路
        }
    }
}
Ok(AIToolHookDecision::Allow)      // 循环结束一律 Allow
```

```rust
// AIToolHandler.rs:1119 起
if isAiInvocation {
    let interception = self.checkToolInterception(tool()).await?;
    if let AIToolHookDecision::Block(_) = interception { return ...; }
}
// 之后才走 access preflight
if let Some(access) = prepared.access { self.executeAccessPreflightAsync(tool(), access).await }
```

**结论**：返回 `{"action":"allow"}` 与不返回任何值，在 Rust 侧走的是同一条路径。钩子**无法**放松权限。

## 5. 用户确认在哪一步

`AIToolHandler.rs:executeAccessPreflightAsync`

1. 读 `permissionSystem.getAiPermissionMode()`（`ReadOnly` / `WorkspaceWrite` / `Full`）。
2. `mode.allowsEffect(effect)` 与 workspace 边界判定。
3. 需要时调 `permissionSystem.checkSandboxEscapeApprovalAsync(tool, chatId)` → `requestPermissionAsync` → 宿主注册的 `asyncPermissionRequester` 回调（即那个弹窗）。
4. `PermissionRequestResult::{ALLOW, DENY, ALLOW_SESSION}`。

`AiPermissionMode` 存在宿主 preferences（`ToolPermissionSystem.rs:173` `getAiPermissionMode`），插件侧无写入口。

**结论**：确认弹窗由宿主偏好驱动，插件只能通过"少调高危工具"间接减少它。

## 6. 插件配置目录与存储

`docs/toolpkg-runtime.md` + `docs/plugin-storage.md`

- `ToolPkg.getConfigDir()`：当前安装所有者的配置目录，**注册期与运行期都可用**（`toolpkg.d.ts:4311`）。
- `ToolPkg.getSpaceDataDir()` / `getLocalDataDir()`：同步 / 本地数据目录（`:4298` / `:4292`）。
- 子包与主入口共用同一安装所有者的配置目录（"Package environment variables belong to the installation owner, including all of its subpackages"）。
- `Tools.Files` 的 `read` / `write` / `exists` / `list` / `mkdir` / `deleteFile` 签名见 `plugins/types/files.d.ts`；`list()` 返回 `DirectoryListingData.entries[]`（每项 `{ name, isDirectory, size, permissions, lastModified }`）。
- `Tools.Storage.dataStore` 是有 schema 迁移的原生 preferences；`Tools.Storage.objects` 是 SQLite。两者都能用，本工程选**普通 JSON 文件**：无 schema 负担、可手工编辑、跨运行时立即可见。

## 7. 本工程的两处保守选择

1. **不 require 跨文件**：主入口编译成单文件 `dist/main.js`，子包独立编译。ToolPkg 运行时确实支持 `require("./x.js")`（内置 `change_review/dist/main.js` 就这么写的），但单文件对版本漂移最不敏感 —— 跨文件加载失败的表现为"插件静默不注册"，很难排查。代价是 `mergeSettings` 在 `src/main.ts` 与 `src/tools/style_tools.ts` 各有一份，改动时必须同改。
2. **不返回任何 intercept 决策**：见 §4。生命周期钩子只写审计，不参与放行判断。

## 8. 未验证项（装机后按此清单实测）

| 项 | 怎么验 | 不通过怎么办 |
| --- | --- | --- |
| `after_compose_system_prompt` 的 payload 里 `systemPrompt` 非空 | 开 `previewOnly` 后聊一句，看 `/style status` 的 `counters.systemPromptCalls` 是否增长、`lastProfileChars` 是否大于 0 | 长度恒为 0 说明该阶段 payload 不含 `systemPrompt`，改用 `compose_system_prompt_sections` 阶段 |
| 多插件叠加顺序 | 同时开 `plan_mode`，看规范段是否被覆盖 | 若被覆盖，改用 `registerPromptFinalizeHook` 在 `before_send_to_model` 阶段补注入 |
| `filter_tool_prompt_items` 的 `availableTools` 形态 | 配 `hidePatterns: ["browser_*"]`，看模型还调不调 `browser_*` | 若无效，改挂 `filter_tool_call_tools` 阶段（已同时注册，两个阶段都在处理） |
| 子包与主入口看到同一个 configDir | 用 `style_configure` 改档位，再 `/style status` 对比 | 若不同，子包改用 `ToolPkg.getSpaceDataDir()` 并统一路径 |
| `Tools.Files.write(path, content, true)` 的追加语义 | 连做两次工具调用，看审计文件是否两行 | 若被覆盖，改为读出全文再整体写回 |

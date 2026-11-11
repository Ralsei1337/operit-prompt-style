# 输出风格助手 Prompt Style Assistant

让助手的回复结构保持稳定，而不是让它的说法变来变去。

[![ToolPkg](https://img.shields.io/badge/ToolPkg-2.0.0-blue)](https://github.com/AAswordman/Operit2)

---

## 解决什么

同一个助手，不同轮次的回复形态常常漂移：有时先铺三段背景再给结论，有时一句"我理解你的需求"开场，有时缺个参数就停下来反问，有时工具报错就在原地重试五次。

这不是能力问题，是输出形态没有约束。本插件在系统提示词组装时追加一段**输出规范**，把结构钉住。

## 三条能力

**1. 输出规范注入** —— 七条格式约定，覆盖结论先行、无开场套话、篇幅贴合复杂度、缺信息用占位符继续、工具失败换实现、长任务给阶段结论、区分已确认与未验证。

**2. 三档风格** —— 精简 / 平衡 / 详尽。精简档只有中文条目、省掉英文对照，上下文占用最小；详尽档追加取舍理由、边界条件与验证方式。

**3. 工具清单收敛** —— 按通配符隐藏用不上的工具，减少模型的无效调用；配套的调用审计能看出哪些工具从没被用过。

## 安装

1. 下载 `com.operit.prompt_style-1.0.0.toolpkg`
2. Operit2 → 包管理 → 导入 `.toolpkg`
3. 启用容器（`style_tools` 子包按需开启）
4. 聊天里执行 `/style on`

装完先别急着开，用预览模式看一眼效果：

```
/style preview on     # 只记录将要注入的字符数，不改写提示词
# 聊一句
/style status         # 看 profile.lastProfileChars
/style preview off    # 确认无误再真正注入
```

## 命令

| 子命令 | 作用 |
| --- | --- |
| `status` | 当前档位、注入状态、钩子注册结果、统计 |
| `on` / `off` | 总开关 |
| `mode balanced\|concise\|detailed` | 切换档位（自动启用） |
| `hide <pattern...>` | 隐藏工具，支持结尾 `*` |
| `unhide <pattern...>` | 取消隐藏 |
| `preview on\|off` | 预览模式 |
| `snapshots` / `revert [name]` | 配置快照与回滚 |
| `audit [n]` | 最近工具调用审计 |
| `reset` | 重置为默认 |

子包工具：`style_status` / `style_configure` / `style_audit` / `style_revert`。

## 设计原则

**只改输出格式。** 规范正文里每一条都是可观察的输出约定，不涉及人格、语气、内容取向。单测有禁词扫描用例守着这条边界。

**幂等。** 注入段带标记，重复 compose 直接返回 `null`，不会越叠越长。

**可回滚。** 每次改配置先留快照。

**失败不崩。** 配置读不出来就用默认值，钩子出错返回 `null`，不影响对话。

## 与角色卡的关系

不冲突，作用在不同层：角色卡管"是谁、怎么说话"，本插件管"回复怎么组织"。

如果角色卡里有"必须始终先征询用户同意"这类**流程性**要求，会与本插件的"缺信息用占位符继续"有摩擦。改角色卡那一条，而不是关掉本插件。

## 已知边界

- 只影响 `after_compose_system_prompt` 阶段。绕过系统提示词组装的链路（如独立小工具调用）不受影响。
- 隐藏工具只是让它不出现在模型可见清单里，不等于禁用。
- 审计记录写本地配置目录，不联网、不上传。

## 结构

```
src/main.ts                # 主入口：3 钩子 + /style 命令 + 设置/快照/审计
src/tools/style_tools.ts   # 子包：4 个模型可见工具
types/                     # Operit2 官方 ToolPkg v2 类型声明（33 个 .d.ts）
scripts/build.mjs          # 打包 .toolpkg（内置最小 ZIP 写入，无三方依赖）
test/unit.test.mjs         # 25 项离线单测（假 ToolPkg/Tools 运行时）
docs/DESIGN.md             # 设计取舍：为什么不做内容替换、为什么单文件
docs/RUNTIME-FACTS.md      # 宿主机理证据：钩子契约、返回语义、存储 API
docs/STYLE-GUIDE.md        # 使用指南与规范条目说明
```

## 构建

```bash
npm install
npm run build      # tsc → dist/
npm test           # 25 项离线单测
npm run pack       # → artifacts/com.operit.prompt_style-1.0.0.toolpkg
```

## 许可

MIT

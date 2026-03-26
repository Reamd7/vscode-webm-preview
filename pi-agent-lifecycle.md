# PI Agent 生命周期调研报告

## 生命周期流程图

```
pi starts (CLI only)
  │
  ├─► session_directory (CLI startup only, no ctx)
  └─► session_start
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify messages)            │       │
  │   ├─► before_provider_request                  │       │
  │   │                                            │       │
  │   │   LLM responds, may call tools:            │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  └─► agent_end                                            │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/new (new session) or /resume (switch session)
  ├─► session_before_switch (can cancel)
  └─► session_switch

/fork
  ├─► session_before_fork (can cancel)
  └─► session_fork

/compact or auto-compaction
  ├─► session_before_compact (can cancel or customize)
  └─► session_compact

/tree navigation
  ├─► session_before_tree (can cancel or customize)
  └─► session_tree

/model or Ctrl+P (model selection/cycling)
  └─► model_select

exit (Ctrl+C, Ctrl+D)
  └─► session_shutdown
```

## 事件分类汇总

### Session 事件

| 事件                     | 说明                        | 可操作                                                         |
| ------------------------ | --------------------------- | -------------------------------------------------------------- |
| `session_directory`      | CLI 启动时决定 session 目录 | 返回 `{ sessionDir: string }`                                  |
| `session_start`          | session 加载时              | -                                                              |
| `session_before_switch`  | `/new` 或 `/resume` 前      | 返回 `{ cancel: true }` 取消                                   |
| `session_switch`         | session 切换后              | -                                                              |
| `session_before_fork`    | `/fork` 前                  | 返回 `{ cancel: true }` 或 `{ skipConversationRestore: true }` |
| `session_fork`           | fork 后                     | -                                                              |
| `session_before_compact` | `/compact` 前               | 返回 `{ cancel: true }` 或 `{ compaction: ... }` 自定义        |
| `session_compact`        | compact 后                  | -                                                              |
| `session_before_tree`    | `/tree` 导航前              | 返回 `{ cancel: true }` 或 `{ summary: ... }` 自定义           |
| `session_tree`           | tree 导航后                 | -                                                              |
| `session_shutdown`       | Ctrl+C/D 退出时             | 清理资源                                                       |

### Agent 事件

| 事件                 | 说明                                  | 可操作                                          |
| -------------------- | ------------------------------------- | ----------------------------------------------- |
| `before_agent_start` | 用户提交 prompt 后                    | 返回 `{ message: ..., systemPrompt: ... }` 注入 |
| `agent_start`        | agent 循环开始                        | -                                               |
| `agent_end`          | agent 循环结束（所有 turn 完成）      | -                                               |
| `turn_start`         | 每个 turn 开始                        | -                                               |
| `turn_end`           | 每个 turn 结束                        | -                                               |
| `message_start`      | 消息开始（user/assistant/toolResult） | -                                               |
| `message_update`     | assistant 流式更新                    | -                                               |
| `message_end`        | 消息结束                              | -                                               |

### Tool 事件

| 事件                    | 说明         | 可操作                                                   |
| ----------------------- | ------------ | -------------------------------------------------------- |
| `tool_execution_start`  | 工具开始执行 | -                                                        |
| `tool_call`             | 工具调用前   | 返回 `{ block: true, reason: "..." }` 阻塞               |
| `tool_execution_update` | 工具流式输出 | -                                                        |
| `tool_result`           | 工具执行后   | 返回 `{ content: ..., details: ..., isError: ... }` 修改 |
| `tool_execution_end`    | 工具执行结束 | -                                                        |

### Context 事件

| 事件                      | 说明               | 可操作                              |
| ------------------------- | ------------------ | ----------------------------------- |
| `context`                 | 每次 LLM 调用前    | 返回 `{ messages: [...] }` 修改消息 |
| `before_provider_request` | 发送给 provider 前 | 返回替换后的 payload                |

### Input 事件

| 事件        | 说明                  | 可操作                                                                                         |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `input`     | 用户输入              | 返回 `{ action: "continue" }` / `{ action: "transform", text: ... }` / `{ action: "handled" }` |
| `user_bash` | `!` 或 `!!` bash 命令 | 返回 `{ operations: ... }` 或 `{ result: ... }`                                                |

### Model 事件

| 事件           | 说明       | 可操作 |
| -------------- | ---------- | ------ |
| `model_select` | 模型切换时 | -      |

### Resource 事件

| 事件                 | 说明             | 可操作                                                        |
| -------------------- | ---------------- | ------------------------------------------------------------- |
| `resources_discover` | session_start 后 | 返回 `{ skillPaths: ..., promptPaths: ..., themePaths: ... }` |

## 自定义 Command

通过 `pi.registerCommand()` 注册：

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

使用：`/hello` 或 `/hello something`

### 带参数补全

```typescript
import type { AutocompleteItem } from "@mariozechner/pi-tui";

pi.registerCommand("deploy", {
  description: "Deploy to environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"];
    return envs.filter((e) => e.startsWith(prefix)).map((e) => ({ value: e, label: e }));
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`Deploying to: ${args}`, "info");
  },
});
```

### 命令冲突处理

多个扩展注册同名命令时，自动分配后缀如 `/review:1`、`/review:2`。

## ExtensionContext 常用属性/方法

| 属性/方法               | 说明                                         |
| ----------------------- | -------------------------------------------- |
| `ctx.ui`                | UI 交互（notify, confirm, select, input 等） |
| `ctx.cwd`               | 当前工作目录                                 |
| `ctx.sessionManager`    | 只读 session 访问                            |
| `ctx.model`             | 当前模型                                     |
| `ctx.isIdle()`          | agent 是否空闲                               |
| `ctx.abort()`           | 中断当前操作                                 |
| `ctx.shutdown()`        | 优雅退出                                     |
| `ctx.getContextUsage()` | 获取上下文使用情况                           |
| `ctx.compact()`         | 触发 compaction                              |

## ExtensionCommandContext 额外方法（仅命令处理器）

| 方法                         | 说明                    |
| ---------------------------- | ----------------------- |
| `ctx.waitForIdle()`          | 等待 agent 空闲         |
| `ctx.newSession()`           | 创建新 session          |
| `ctx.fork(entryId)`          | Fork session            |
| `ctx.navigateTree(targetId)` | 树导航                  |
| `ctx.reload()`               | 重载扩展/技能/提示/主题 |

## Task Loop 系统

### 启动方式

唯一入口为 `/task-loop <prompt>` 命令（由 `.pi/extensions/task-loop.ts` 注册）。

```
/task-loop 实现一个 WebM 文件解析库
```

命令执行后：

1. 检查 `.pi/task.json` 是否已存在（存在则拒绝，防止重复启动）
2. 将 prompt 写入 `.pi/agent-loop.txt`（持久化 goal，供中断恢复使用）
3. 创建 `.pi/task.json`（初始状态 `brainstorming`）
4. 注入 brainstorm prompt 让主 agent 开始创作 spec

### 状态机

项目级别：

```
brainstorming → reviewing_spec → planning → executing → validating → completed
(等待 spec)    (subagent 审查)   (生成计划)  (逐任务)    (最终验收)   (结束)
```

任务级别：

```
pending → preparing → reflecting → ready → in_progress → verifying → done
(空标题)  (生成 spec)  (反思规模)   (等实施)  (主 agent)    (检查+审查)  (报告)
```

核心不变量：每个异步操作（subagent / 硬编码检查）执行前，必须先写入一个"正在进行"的状态。dispatch 遇到"正在进行"状态时不做任何事（等操作完成后再推进）。

### Subagent 环境隔离

`runSubagent()` 启动子进程时注入 `PI_SUBAGENT=1` 环境变量。以下扩展在 subagent 中跳过：

| 扩展                   | 行为                                   |
| ---------------------- | -------------------------------------- |
| `task-loop.ts`         | `if (process.env.PI_SUBAGENT) return;` |
| `task-guard.ts`        | `if (process.env.PI_SUBAGENT) return;` |
| `auto-lint.ts`         | `if (process.env.PI_SUBAGENT) return;` |
| `strip-superpowers.ts` | 不跳过（subagent 中仍需过滤）          |

嵌套 subagent 被禁止：`runSubagent()` 在 `PI_SUBAGENT` 已设置时直接返回错误。

## Agent 模块架构

### 目录结构

每个 subagent 场景是一个自包含的目录：

```
.pi/agents/
├── _utils.ts                    # 共享工具函数
├── review-spec/
│   ├── index.ts                 # exports reviewSpec()
│   ├── prompt.md                # subagent prompt 模板
│   └── tool.ts                  # TypeBox schema (submit_review tool)
├── review-plan/
│   ├── index.ts                 # exports reviewPlan()
│   ├── prompt.md
│   └── tool.ts
├── plan/
│   ├── index.ts                 # exports generatePlan()
│   ├── prompt.md
│   └── tool.ts
├── reflect-size/
│   ├── index.ts                 # exports reflectSize()
│   ├── prompt.md
│   └── tool.ts
├── review-spec-compliance/
│   ├── index.ts                 # exports reviewSpecCompliance()
│   ├── prompt.md
│   └── tool.ts
├── review-code-quality/
│   ├── index.ts                 # exports reviewCodeQuality()
│   ├── prompt.md
│   └── tool.ts
├── generate-report/
│   ├── index.ts                 # exports generateReport()
│   ├── prompt.md
│   └── tool.ts
├── gap-analysis/
│   ├── index.ts                 # exports analyzeGap()
│   ├── prompt.md
│   └── tool.ts
├── final-validation/
│   ├── index.ts                 # exports validateProject()
│   ├── prompt.md
│   └── tool.ts
└── prepare-task/
    ├── index.ts                 # exports prepareTask()
    └── prompt.md                # (无 tool.ts — 纯副作用 agent)
```

### Agent 模块组成

| 文件        | 用途                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| `index.ts`  | 导出语义化命名的 async 函数（如 `reviewSpec()`、`generatePlan()`）                          |
| `prompt.md` | 模板文件，通过 `{{variable}}` 占位符注入上下文                                              |
| `tool.ts`   | TypeBox schema，注册为 PI tool（如 `submit_review`），强制 LLM 通过 tool_use 返回结构化数据 |

### 共享工具 (`_utils.ts`)

| 函数                                     | 用途                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `loadAgentPrompt(import.meta.url, vars)` | 加载同目录下 `prompt.md` 并替换占位符                                   |
| `getToolExtensionPath(import.meta.url)`  | 获取同目录下 `tool.ts` 绝对路径                                         |
| `extractResult<T>(result)`               | 从 SubagentResult 提取结构化结果（优先 toolResult，fallback JSON 解析） |
| `runSubagent`                            | 从 `../lib/subagent.js` re-export                                       |

### 结构化输出机制

Subagent 不再依赖 prompt 要求 LLM 输出 JSON 文本，而是通过 `tool_use` 强制返回结构化数据：

1. `tool.ts` 使用 TypeBox 定义参数 schema，通过 `pi.registerTool()` 注册（如 `submit_review`）
2. `prompt.md` 要求 LLM "必须调用 submit_xxx tool 返回结果"
3. `index.ts` 通过 `extensions: [getToolExtensionPath(import.meta.url)]` 将 tool.ts 传给 subagent
4. `runSubagent()` 从 `message_end` 事件的 `toolCall` content 中提取参数
5. `extractResult<T>()` 返回类型安全的结构化数据

### 仍通过 loadPrompt 注入的 prompt（非 subagent）

以下 3 个 prompt 注入给**主 agent**（不经过 subagent），仍存放在 `.pi/prompts/`：

| 文件             | 用途                         | 注入方式                  |
| ---------------- | ---------------------------- | ------------------------- |
| `brainstorm.md`  | 引导主 agent 创作 spec       | `before_agent_start` 注入 |
| `debug-guide.md` | 系统化调试指导（审查失败时） | `before_agent_start` 注入 |
| `finish.md`      | 引导主 agent 完成收尾        | `before_agent_start` 注入 |

## Subagent 基础设施 (`runSubagent`)

位于 `.pi/lib/subagent.ts`，封装 `pi --mode json -p --no-session` 的 spawn 逻辑。

### 接口

```typescript
interface SubagentResult {
  output: string; // 最后一条 assistant 消息文本
  toolResult?: Record<string, unknown>; // tool_use 结构化返回（优先）
  exitCode: number;
  error?: string;
}

function runSubagent(
  task: string,
  cwd: string,
  options?: {
    systemPrompt?: string;
    tools?: string[]; // 工具白名单（如 ['read', 'bash']）
    extensions?: string[]; // extension 文件路径（通过 -e 传递）
    signal?: AbortSignal;
  },
): Promise<SubagentResult>;
```

### 工作原理

1. 检测 pi CLI 的启动方式（node script / binary / global）
2. 构建参数：`--mode json -p --no-session [--tools] [-e ext1 -e ext2] [--append-system-prompt tmpfile] <task>`
3. Spawn 子进程，注入 `PI_SUBAGENT=1` 环境变量
4. 流式解析 stdout 的 JSONL 事件流
5. 从 `message_end` 事件中提取 `text` 和 `toolCall` content
6. 返回 `{ output, toolResult, exitCode, error }`

## 参考资料

- PI Agent 文档: `@mariozechner/pi-coding-agent` 包 `docs/extensions.md`
- 类型定义: `dist/core/extensions/types.d.ts`
- 版本: 0.62.0

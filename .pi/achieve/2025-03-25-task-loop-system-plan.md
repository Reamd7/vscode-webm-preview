# Task Loop System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个状态驱动的自循环任务系统，通过 pi extension + prompt 注入 + subagent 协作，实现从目标输入到任务拆分、实施、验证、完成的全自动闭环。

**Architecture:** Extension 层读取 `task.json` 状态，在 `agent_end` 时根据当前阶段注入对应 prompt 或派发 subagent。LLM 层负责推理（头脑风暴、反思、实施）。一切行为由 `task.json` 状态驱动，可随时中断恢复。

**Tech Stack:** TypeScript, pi Extension API (`@mariozechner/pi-coding-agent`), pi subagent (JSON mode spawned process)

---

## File Structure

```
.pi/
├── extensions/
│   ├── task-loop.ts         # [CREATE] 核心状态机 extension
│   ├── auto-lint.ts         # [KEEP]   硬编码检查（已有）
│   └── agent-loop.ts        # [DELETE] 被 task-loop.ts 取代
├── lib/
│   ├── task-state.ts        # [CREATE] task.json 读写和状态转换
│   ├── subagent.ts          # [CREATE] subagent 派发工具
│   └── prompt-loader.ts     # [CREATE] prompt 模板加载和变量替换
├── prompts/
│   ├── brainstorm.md        # [CREATE] 头脑风暴 prompt
│   ├── plan.md              # [CREATE] 生成任务计划 prompt
│   ├── prepare-task.md      # [CREATE] 任务预备 prompt
│   ├── reflect-size.md      # [CREATE] 反思任务大小 prompt
│   ├── verify-quality.md    # [CREATE] 验证完成质量 prompt
│   ├── generate-report.md   # [CREATE] 生成完成报告 prompt
│   └── gap-analysis.md      # [CREATE] 任务间隙分析 prompt
├── task.json                # [RUNTIME] 任务状态（运行时生成）
├── task/
│   ├── spec.md              # [RUNTIME] 总目标 spec
│   └── 001/
│       ├── spec.md          # [RUNTIME] 任务 spec
│       └── report.md        # [RUNTIME] 完成报告
├── package.json
└── tsconfig.json
```

每个文件职责：

- `task-loop.ts` — 监听 `agent_end`，读取 `task.json`，根据状态决定注入 prompt 还是派发 subagent
- `task-state.ts` — 纯函数：`readTask()`, `writeTask()`, `advanceTask()`, `splitTask()`, `insertTasks()`
- `subagent.ts` — 封装 `pi --mode json -p --no-session` 的 spawn 逻辑，返回结构化输出
- `prompt-loader.ts` — 读取 `.md` 模板，替换 `{{variable}}` 占位符

---

## Chunk 1: 基础设施层（task-state + prompt-loader + subagent）

### Task 1: task-state.ts — task.json 读写和状态管理

**Files:**

- Create: `.pi/lib/task-state.ts`

- [ ] **Step 1: 定义 TypeScript 类型**

```typescript
// .pi/lib/task-state.ts

export type ProjectStatus = "brainstorming" | "planning" | "executing" | "completed";
export type TaskStatus = "pending" | "preparing" | "ready" | "in_progress" | "verifying" | "done";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  summary: string | null;
}

export interface TaskFile {
  goal: string;
  status: ProjectStatus;
  currentTaskId: string | null;
  tasks: Task[];
}
```

- [ ] **Step 2: 实现读写函数**

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const TASK_FILE = "task.json";

export async function readTaskFile(piDir: string): Promise<TaskFile | null> {
  try {
    const content = await readFile(join(piDir, TASK_FILE), "utf8");
    return JSON.parse(content) as TaskFile;
  } catch {
    return null;
  }
}

export async function writeTaskFile(piDir: string, taskFile: TaskFile): Promise<void> {
  const filePath = join(piDir, TASK_FILE);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(taskFile, null, 2), "utf8");
}
```

- [ ] **Step 3: 实现状态操作纯函数**

```typescript
export function createTaskFile(goal: string): TaskFile {
  return { goal, status: "brainstorming", currentTaskId: null, tasks: [] };
}

export function generateTaskId(tasks: Task[]): string {
  const maxId = tasks.reduce((max, t) => {
    const num = parseInt(t.id, 10);
    return num > max ? num : max;
  }, 0);
  return String(maxId + 1).padStart(3, "0");
}

export function getCurrentTask(taskFile: TaskFile): Task | null {
  if (!taskFile.currentTaskId) return null;
  return taskFile.tasks.find((t) => t.id === taskFile.currentTaskId) ?? null;
}

export function getNextPendingTask(taskFile: TaskFile): Task | null {
  return taskFile.tasks.find((t) => t.status === "pending") ?? null;
}

export function updateTaskStatus(taskFile: TaskFile, taskId: string, status: TaskStatus): TaskFile {
  return {
    ...taskFile,
    tasks: taskFile.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
  };
}

export function updateTaskSummary(taskFile: TaskFile, taskId: string, summary: string): TaskFile {
  return {
    ...taskFile,
    tasks: taskFile.tasks.map((t) => (t.id === taskId ? { ...t, summary } : t)),
  };
}

/**
 * 拆分任务：将 targetId 替换为多个新任务
 * 新任务插入到 targetId 所在位置
 */
export function splitTask(
  taskFile: TaskFile,
  targetId: string,
  newTasks: Array<{ title: string }>,
): TaskFile {
  const index = taskFile.tasks.findIndex((t) => t.id === targetId);
  if (index === -1) return taskFile;

  const before = taskFile.tasks.slice(0, index);
  const after = taskFile.tasks.slice(index + 1);
  const allExisting = [...before, ...after];

  const created: Task[] = newTasks.map((nt, i) => ({
    id: generateTaskId([...allExisting, ...before.slice(0, i)]),
    title: nt.title,
    status: "pending" as TaskStatus,
    summary: null,
  }));

  // 重新计算 id，确保不冲突
  let nextNum = Math.max(...taskFile.tasks.map((t) => parseInt(t.id, 10)), 0);
  const createdWithIds: Task[] = newTasks.map((nt) => {
    nextNum++;
    return {
      id: String(nextNum).padStart(3, "0"),
      title: nt.title,
      status: "pending" as TaskStatus,
      summary: null,
    };
  });

  const newTaskList = [...before, ...createdWithIds, ...after];
  const newCurrentId = createdWithIds.length > 0 ? createdWithIds[0].id : taskFile.currentTaskId;

  return {
    ...taskFile,
    tasks: newTaskList,
    currentTaskId: newCurrentId,
  };
}

/**
 * 在指定位置后插入中间任务
 */
export function insertTasksAfter(
  taskFile: TaskFile,
  afterId: string,
  newTasks: Array<{ title: string }>,
): TaskFile {
  const index = taskFile.tasks.findIndex((t) => t.id === afterId);
  if (index === -1) return taskFile;

  let nextNum = Math.max(...taskFile.tasks.map((t) => parseInt(t.id, 10)), 0);
  const created: Task[] = newTasks.map((nt) => {
    nextNum++;
    return {
      id: String(nextNum).padStart(3, "0"),
      title: nt.title,
      status: "pending" as TaskStatus,
      summary: null,
    };
  });

  const newTaskList = [
    ...taskFile.tasks.slice(0, index + 1),
    ...created,
    ...taskFile.tasks.slice(index + 1),
  ];

  return { ...taskFile, tasks: newTaskList };
}

export function advanceToNextTask(taskFile: TaskFile): TaskFile {
  const next = taskFile.tasks.find((t) => t.status === "pending");
  if (!next) {
    return { ...taskFile, currentTaskId: null };
  }
  return { ...taskFile, currentTaskId: next.id };
}

export function allTasksDone(taskFile: TaskFile): boolean {
  return taskFile.tasks.length > 0 && taskFile.tasks.every((t) => t.status === "done");
}
```

- [ ] **Step 4: Commit**

```bash
git add .pi/lib/task-state.ts
git commit -m "feat(task-loop): add task-state module for task.json management"
```

---

### Task 2: prompt-loader.ts — Prompt 模板加载

**Files:**

- Create: `.pi/lib/prompt-loader.ts`

- [ ] **Step 1: 实现模板加载和变量替换**

```typescript
// .pi/lib/prompt-loader.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 加载 prompt 模板并替换 {{variable}} 占位符
 */
export async function loadPrompt(
  piDir: string,
  templateName: string,
  variables: Record<string, string> = {},
): Promise<string> {
  const filePath = join(piDir, "prompts", `${templateName}.md`);
  let content = await readFile(filePath, "utf8");

  for (const [key, value] of Object.entries(variables)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  return content.trim();
}

/**
 * 安全读取文件内容，不存在返回空字符串
 */
export async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add .pi/lib/prompt-loader.ts
git commit -m "feat(task-loop): add prompt-loader for template loading"
```

---

### Task 3: subagent.ts — Subagent 派发

**Files:**

- Create: `.pi/lib/subagent.ts`

- [ ] **Step 1: 实现 subagent spawn 封装**

参考 pi 的 subagent 示例 (`examples/extensions/subagent/index.ts`)，封装为更简单的接口。

```typescript
// .pi/lib/subagent.ts

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export interface SubagentResult {
  output: string;
  exitCode: number;
  error?: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/**
 * 派发 subagent 执行任务
 * 使用 pi --mode json -p --no-session 运行
 *
 * @param task - 发送给 subagent 的 prompt
 * @param cwd - 工作目录
 * @param options.systemPrompt - 可选的 system prompt 追加内容
 * @param options.tools - 可选的工具限制列表
 * @param options.signal - 中断信号
 */
export async function runSubagent(
  task: string,
  cwd: string,
  options: {
    systemPrompt?: string;
    tools?: string[];
    signal?: AbortSignal;
  } = {},
): Promise<SubagentResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (options.tools && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  try {
    if (options.systemPrompt) {
      tmpDir = await mkdtemp(join(tmpdir(), "pi-task-loop-"));
      tmpFile = join(tmpDir, "system-prompt.md");
      await writeFile(tmpFile, options.systemPrompt, "utf8");
      args.push("--append-system-prompt", tmpFile);
    }

    args.push(task);

    const result = await new Promise<SubagentResult>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let lastAssistantText = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
        // 解析 JSON 行以提取最终 assistant 消息
        const lines = stdout.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "message_end" && event.message?.role === "assistant") {
              for (const part of event.message.content) {
                if (part.type === "text") {
                  lastAssistantText = part.text;
                }
              }
            }
          } catch {
            // 忽略非 JSON 行
          }
        }
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        resolve({
          output: lastAssistantText || stdout,
          exitCode: code ?? 0,
          error: code !== 0 ? stderr : undefined,
        });
      });

      proc.on("error", (err) => {
        resolve({
          output: "",
          exitCode: 1,
          error: err.message,
        });
      });

      if (options.signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (options.signal.aborted) kill();
        else options.signal.addEventListener("abort", kill, { once: true });
      }
    });

    return result;
  } finally {
    if (tmpFile)
      try {
        await unlink(tmpFile);
      } catch {
        /* ignore */
      }
    if (tmpDir)
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add .pi/lib/subagent.ts
git commit -m "feat(task-loop): add subagent spawn utility"
```

---

## Chunk 2: Prompt 模板

### Task 4: 创建所有 prompt 模板

**Files:**

- Create: `.pi/prompts/brainstorm.md`
- Create: `.pi/prompts/plan.md`
- Create: `.pi/prompts/prepare-task.md`
- Create: `.pi/prompts/reflect-size.md`
- Create: `.pi/prompts/verify-quality.md`
- Create: `.pi/prompts/generate-report.md`
- Create: `.pi/prompts/gap-analysis.md`

- [ ] **Step 1: brainstorm.md**

```markdown
# 头脑风暴：细化需求

你正在帮助用户细化一个目标。

## 目标

{{goal}}

## 你的任务

1. 仔细理解用户的目标
2. 通过提问来澄清需求（一次一个问题）
3. 探索可能的实现方案（2-3 种）
4. 当你认为需求足够清晰时，生成 spec 文档

## 生成 spec

当需求明确后，将 spec 文档写入 `{{specPath}}`。
spec 应包含：目标、范围、技术方案、约束条件、验收标准。

写完 spec 后告知用户：spec 已生成，准备进入计划阶段。
```

- [ ] **Step 2: plan.md**

```markdown
# 生成任务计划

你是一个任务规划器。根据 spec 生成一个串行的任务列表。

## 总目标

{{goal}}

## Spec 文档

{{spec}}

## 已有上下文

{{context}}

## 输出要求

你必须输出一个 JSON 对象（不要用 markdown 代码块包裹），格式如下：

{
"tasks": [
{ "title": "简明扼要的任务描述" },
{ "title": "简明扼要的任务描述" }
]
}

## 规则

- 任务是串行的，按执行顺序排列
- 每个任务应该能在 15 分钟内完成
- 每个任务应该能在 200k token 上下文中完成
- 任务描述简洁明了，不需要详细方案（后续会展开）
- 只输出 JSON，不要其他文本
```

- [ ] **Step 3: prepare-task.md**

```markdown
# 任务预备：生成任务 Spec

你是一个任务细化器。为一个具体任务生成详细的实施 spec。

## 总目标

{{goal}}

## 总体 Spec

{{projectSpec}}

## 当前任务

- ID: {{taskId}}
- 标题: {{taskTitle}}

## 已完成任务摘要

{{completedSummaries}}

## 输出要求

将任务 spec 写入 `{{taskSpecPath}}`。

spec 应包含：

1. 任务目标
2. 预期产出（具体要创建/修改哪些文件）
3. 实施方案
4. 验收标准（具体的测试/检查项）
5. 预计复杂度评估

写完后告知：任务 spec 已生成。
```

- [ ] **Step 4: reflect-size.md**

```markdown
# 反思任务规模

你是一个任务规模评估器。

## 任务 Spec

{{taskSpec}}

## 问题

这个任务能否满足以下两个条件？

1. 能在 15 分钟内完成
2. 能在 200k token 上下文中完成（包括阅读代码、编写代码、运行测试）

## 输出要求

你必须输出一个 JSON 对象（不要用 markdown 代码块包裹），格式如下：

如果可以完成：
{
"feasible": true,
"reason": "简要说明为什么可以完成"
}

如果不可以完成：
{
"feasible": false,
"reason": "简要说明为什么不能完成",
"tasks": [
{ "title": "拆分后的子任务描述" },
{ "title": "拆分后的子任务描述" }
]
}

只输出 JSON，不要其他文本。
```

- [ ] **Step 5: verify-quality.md**

```markdown
# 验证任务完成质量

你是一个质量审查器。检查任务是否满足验收标准。

## 任务 Spec

{{taskSpec}}

## Git 工作区状态

{{gitStatus}}

## Git Diff

{{gitDiff}}

## 输出要求

你必须输出一个 JSON 对象（不要用 markdown 代码块包裹），格式如下：

{
"passed": true/false,
"issues": ["问题1", "问题2"],
"suggestions": ["建议1"]
}

只输出 JSON，不要其他文本。
```

- [ ] **Step 6: generate-report.md**

```markdown
# 生成任务完成报告

你是一个报告生成器。为已完成的任务生成完成报告。

## 任务 Spec

{{taskSpec}}

## Git 工作区状态

{{gitStatus}}

## Git Diff（本任务的变更）

{{gitDiff}}

## Git Log（本任务的提交）

{{gitLog}}

## 输出要求

生成一份报告写入 `{{reportPath}}`，包含：

1. **完成摘要**：一句话概括做了什么
2. **变更文件列表**：列出所有修改的文件
3. **关键决策**：实施过程中的重要决策
4. **测试覆盖**：测试情况
5. **遗留问题**：如果有的话

同时输出一个简短的 summary（不超过 100 字），用于写入 task.json。

输出格式（JSON，不要代码块包裹）：
{
"summary": "简短摘要，不超过 100 字"
}

先写报告文件，再输出 JSON。
```

- [ ] **Step 7: gap-analysis.md**

```markdown
# 任务间隙分析

你是一个任务计划审查器。分析已完成的任务和下一个任务之间是否需要插入中间任务。

## 总目标

{{goal}}

## 总体 Spec

{{projectSpec}}

## 刚完成的任务

- ID: {{completedTaskId}}
- 标题: {{completedTaskTitle}}
- 摘要: {{completedTaskSummary}}

## 下一个任务

- ID: {{nextTaskId}}
- 标题: {{nextTaskTitle}}

## 已完成任务摘要

{{completedSummaries}}

## 输出要求

你必须输出一个 JSON 对象（不要用 markdown 代码块包裹），格式如下：

如果不需要插入：
{
"needsIntermediateTasks": false,
"reason": "简要说明为什么不需要"
}

如果需要插入：
{
"needsIntermediateTasks": true,
"reason": "简要说明为什么需要",
"tasks": [
{ "title": "中间任务描述" }
]
}

只输出 JSON，不要其他文本。
```

- [ ] **Step 8: Commit**

```bash
git add .pi/prompts/
git commit -m "feat(task-loop): add all prompt templates"
```

---

## Chunk 3: 核心 Extension — task-loop.ts

### Task 5: task-loop.ts — 状态机驱动的核心 extension

**Files:**

- Create: `.pi/extensions/task-loop.ts`
- Delete: `.pi/extensions/agent-loop.ts`

- [ ] **Step 1: 实现 extension 骨架和触发入口**

```typescript
// .pi/extensions/task-loop.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  readTaskFile,
  writeTaskFile,
  createTaskFile,
  getCurrentTask,
  updateTaskStatus,
  updateTaskSummary,
  advanceToNextTask,
  allTasksDone,
  splitTask,
  insertTasksAfter,
  type TaskFile,
  type Task,
} from "../lib/task-state.js";
import { loadPrompt, safeReadFile } from "../lib/prompt-loader.js";
import { runSubagent } from "../lib/subagent.js";

export default function taskLoop(pi: ExtensionAPI): void {
  // 追踪文件变更（用于硬编码检查触发）
  let filesModified = false;

  pi.on("tool_call", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      filesModified = true;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const piDir = join(ctx.cwd, ".pi");
    const taskFile = await readTaskFile(piDir);

    if (!taskFile) {
      // 检查 agent-loop.txt 是否有新目标
      await handleNoTaskFile(pi, piDir, ctx);
      return;
    }

    switch (taskFile.status) {
      case "brainstorming":
        await handleBrainstorming(pi, piDir, taskFile, ctx);
        break;
      case "planning":
        await handlePlanning(pi, piDir, taskFile, ctx);
        break;
      case "executing":
        await handleExecuting(pi, piDir, taskFile, ctx, filesModified);
        filesModified = false;
        break;
      case "completed":
        // 不做任何事
        break;
    }
  });
}
```

- [ ] **Step 2: 实现 handleNoTaskFile — 检测目标并创建 task.json**

```typescript
async function handleNoTaskFile(pi: ExtensionAPI, piDir: string, ctx: any): Promise<void> {
  const loopFilePath = join(piDir, "agent-loop.txt");
  const content = await safeReadFile(loopFilePath);
  const goal = content.trim();

  if (!goal) return;

  // 创建 task.json
  const taskFile = createTaskFile(goal);
  await writeTaskFile(piDir, taskFile);

  // 注入头脑风暴 prompt
  const prompt = await loadPrompt(piDir, "brainstorm", {
    goal,
    specPath: join(piDir, "task", "spec.md"),
  });

  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
  } else {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }
}
```

- [ ] **Step 3: 实现 handleBrainstorming — 检测 spec 并进入 planning**

```typescript
async function handleBrainstorming(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: any,
): Promise<void> {
  const specPath = join(piDir, "task", "spec.md");
  const spec = await safeReadFile(specPath);

  if (spec.trim()) {
    // spec 已生成，进入 planning
    const updated = { ...taskFile, status: "planning" as const };
    await writeTaskFile(piDir, updated);

    // 用 subagent 生成任务计划
    const context = await buildCompletedSummaries(taskFile);
    const planPrompt = await loadPrompt(piDir, "plan", {
      goal: taskFile.goal,
      spec,
      context,
    });

    const result = await runSubagent(planPrompt, ctx.cwd, {
      tools: ["read", "bash"],
    });

    // 解析任务计划
    const plan = parseJson(result.output);
    if (plan && Array.isArray(plan.tasks)) {
      let planned: TaskFile = { ...updated, status: "executing", tasks: [] };
      let id = 0;
      for (const t of plan.tasks) {
        id++;
        planned.tasks.push({
          id: String(id).padStart(3, "0"),
          title: t.title,
          status: "pending",
          summary: null,
        });
      }
      planned.currentTaskId = planned.tasks[0]?.id ?? null;
      await writeTaskFile(piDir, planned);

      // 注入消息告知主 agent 进入执行模式
      const msg = `任务计划已生成，共 ${planned.tasks.length} 个任务。开始执行第一个任务。`;
      pi.sendUserMessage(msg, { deliverAs: "followUp" });
    } else {
      // 解析失败，重新尝试
      pi.sendUserMessage("任务计划生成失败，请重新生成。", { deliverAs: "followUp" });
    }
  } else {
    // spec 还没生成，继续头脑风暴
    // 不做任何额外注入，让用户继续交互
  }
}
```

- [ ] **Step 4: 实现 handleExecuting — 任务执行状态机**

```typescript
async function handleExecuting(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: any,
  filesModified: boolean,
): Promise<void> {
  const current = getCurrentTask(taskFile);

  if (!current) {
    // 所有任务完成，检查是否满足 spec
    if (allTasksDone(taskFile)) {
      await handleFinalValidation(pi, piDir, taskFile, ctx);
    }
    return;
  }

  switch (current.status) {
    case "pending":
      await handleTaskPending(pi, piDir, taskFile, current, ctx);
      break;
    case "preparing":
      await handleTaskPreparing(pi, piDir, taskFile, current, ctx);
      break;
    case "ready":
      await handleTaskReady(pi, piDir, taskFile, current, ctx);
      break;
    case "in_progress":
      await handleTaskInProgress(pi, piDir, taskFile, current, ctx, filesModified);
      break;
    case "verifying":
      await handleTaskVerifying(pi, piDir, taskFile, current, ctx);
      break;
    case "done":
      await handleTaskDone(pi, piDir, taskFile, current, ctx);
      break;
  }
}
```

- [ ] **Step 5: 实现 handleTaskPending — 进入预备状态**

```typescript
async function handleTaskPending(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: any,
): Promise<void> {
  // 更新状态为 preparing
  const updated = updateTaskStatus(taskFile, task.id, "preparing");
  await writeTaskFile(piDir, updated);

  // 用 subagent 生成任务 spec
  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = await buildCompletedSummaries(taskFile);
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");

  const prompt = await loadPrompt(piDir, "prepare-task", {
    goal: taskFile.goal,
    projectSpec,
    taskId: task.id,
    taskTitle: task.title,
    completedSummaries,
    taskSpecPath,
  });

  const result = await runSubagent(prompt, ctx.cwd, {
    tools: ["read", "write", "bash"],
  });

  // 进入 preparing 完成后的反思阶段
  // 下一轮 agent_end 会处理 preparing 状态
  pi.sendUserMessage("任务 spec 生成中...", { deliverAs: "followUp" });
}
```

- [ ] **Step 6: 实现 handleTaskPreparing — 反思任务大小**

```typescript
async function handleTaskPreparing(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: any,
): Promise<void> {
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");
  const taskSpec = await safeReadFile(taskSpecPath);

  if (!taskSpec.trim()) {
    // spec 还没生成完，等待
    return;
  }

  // 用 subagent 反思任务大小
  const prompt = await loadPrompt(piDir, "reflect-size", { taskSpec });
  const result = await runSubagent(prompt, ctx.cwd, {
    tools: ["read"],
  });

  const reflection = parseJson(result.output);
  if (reflection && reflection.feasible === true) {
    // 可以完成，进入 ready
    const updated = updateTaskStatus(taskFile, task.id, "ready");
    await writeTaskFile(piDir, updated);
    pi.sendUserMessage(
      `任务 ${task.id} (${task.title}) 已就绪，开始实施。\n\n请阅读任务 spec: ${taskSpecPath}`,
      { deliverAs: "followUp" },
    );
  } else if (reflection && reflection.feasible === false && Array.isArray(reflection.tasks)) {
    // 需要拆分
    const updated = splitTask(taskFile, task.id, reflection.tasks);
    const finalUpdated = { ...updated, status: "executing" as const };
    await writeTaskFile(piDir, finalUpdated);
    pi.sendUserMessage(`任务 ${task.id} 过大，已拆分为 ${reflection.tasks.length} 个子任务。`, {
      deliverAs: "followUp",
    });
  } else {
    // 解析失败，默认可行
    const updated = updateTaskStatus(taskFile, task.id, "ready");
    await writeTaskFile(piDir, updated);
    pi.sendUserMessage(
      `任务 ${task.id} (${task.title}) 已就绪，开始实施。\n\n请阅读任务 spec: ${taskSpecPath}`,
      { deliverAs: "followUp" },
    );
  }
}
```

- [ ] **Step 7: 实现 handleTaskReady — 开始实施**

```typescript
async function handleTaskReady(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: any,
): Promise<void> {
  // 更新状态为 in_progress
  const updated = updateTaskStatus(taskFile, task.id, "in_progress");
  await writeTaskFile(piDir, updated);

  const taskSpecPath = join(piDir, "task", task.id, "spec.md");
  const taskSpec = await safeReadFile(taskSpecPath);

  // 注入实施 prompt 给主 agent
  const prompt = [
    `## 当前任务: ${task.id} - ${task.title}`,
    "",
    "请阅读以下任务 spec 并实施：",
    "",
    taskSpec,
    "",
    "## 要求",
    "- 代码需要通过 lint, typecheck, 测试",
    "- 测试覆盖率 100%",
    "- 完成后告知我",
  ].join("\n");

  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
  } else {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }
}
```

- [ ] **Step 8: 实现 handleTaskInProgress — 实施完成进入验证**

```typescript
async function handleTaskInProgress(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: any,
  filesModified: boolean,
): Promise<void> {
  if (!filesModified) return; // 没有文件变更，不做检查

  // 更新状态为 verifying
  const updated = updateTaskStatus(taskFile, task.id, "verifying");
  await writeTaskFile(piDir, updated);

  // 硬编码检查
  const checks = await runHardcodedChecks(pi, ctx.cwd);

  if (checks.errors.length > 0) {
    // 检查未通过，回到 in_progress
    const reverted = updateTaskStatus(updated, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);

    pi.sendUserMessage(`硬编码检查未通过，请修复：\n\n${checks.errors.join("\n\n")}`, {
      deliverAs: "followUp",
    });
    return;
  }

  // LLM 反思质量
  await handleQualityReflection(pi, piDir, updated, task, ctx);
}

async function runHardcodedChecks(pi: ExtensionAPI, cwd: string): Promise<{ errors: string[] }> {
  const errors: string[] = [];

  const fmtResult = await pi.exec("pnpm", ["fmt"], { timeout: 30000 });
  if (fmtResult.code !== 0) {
    const output = [fmtResult.stdout, fmtResult.stderr].filter(Boolean).join("\n");
    errors.push(`\`pnpm fmt\` failed (exit ${fmtResult.code}):\n${output}`);
  }

  const lintResult = await pi.exec("pnpm", ["lint:fix"], { timeout: 30000 });
  if (lintResult.code !== 0) {
    const output = [lintResult.stdout, lintResult.stderr].filter(Boolean).join("\n");
    errors.push(`\`pnpm lint:fix\` failed (exit ${lintResult.code}):\n${output}`);
  }

  if (errors.length > 0) return { errors };

  const typecheckResult = await pi.exec("pnpm", ["typecheck"], { timeout: 60000 });
  if (typecheckResult.code !== 0) {
    const output = [typecheckResult.stdout, typecheckResult.stderr].filter(Boolean).join("\n");
    errors.push(`\`pnpm typecheck\` failed (exit ${typecheckResult.code}):\n${output}`);
  }

  if (errors.length > 0) return { errors };

  const testResult = await pi.exec("pnpm", ["test"], { timeout: 120000 });
  if (testResult.code !== 0) {
    const output = [testResult.stdout, testResult.stderr].filter(Boolean).join("\n");
    errors.push(`\`pnpm test\` failed (exit ${testResult.code}):\n${output}`);
  }

  return { errors };
}
```

- [ ] **Step 9: 实现 handleQualityReflection — LLM 反思**

```typescript
async function handleQualityReflection(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: any,
): Promise<void> {
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");
  const taskSpec = await safeReadFile(taskSpecPath);

  // 获取 git 信息
  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10000 });
  const gitDiff = await pi.exec("git", ["diff", "--stat"], { timeout: 10000 });

  const prompt = await loadPrompt(piDir, "verify-quality", {
    taskSpec,
    gitStatus: gitStatus.stdout || "(clean)",
    gitDiff: gitDiff.stdout || "(no changes)",
  });

  const result = await runSubagent(prompt, ctx.cwd, {
    tools: ["read", "bash"],
  });

  const quality = parseJson(result.output);

  if (quality && quality.passed === false) {
    // 质量不达标，回到 in_progress
    const reverted = updateTaskStatus(taskFile, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);

    const issues = (quality.issues || []).join("\n- ");
    pi.sendUserMessage(`任务质量检查未通过：\n- ${issues}\n\n请修复后继续。`, {
      deliverAs: "followUp",
    });
    return;
  }

  // 质量通过，生成报告
  await handleGenerateReport(pi, piDir, taskFile, task, ctx);
}
```

- [ ] **Step 10: 实现 handleGenerateReport — 生成完成报告**

```typescript
async function handleGenerateReport(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: any,
): Promise<void> {
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");
  const taskSpec = await safeReadFile(taskSpecPath);
  const reportPath = join(piDir, "task", task.id, "report.md");

  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10000 });
  const gitDiff = await pi.exec("git", ["diff"], { timeout: 10000 });
  const gitLog = await pi.exec("git", ["log", "--oneline", "-10"], { timeout: 10000 });

  const prompt = await loadPrompt(piDir, "generate-report", {
    taskSpec,
    gitStatus: gitStatus.stdout || "(clean)",
    gitDiff: gitDiff.stdout || "(no changes)",
    gitLog: gitLog.stdout || "(no commits)",
    reportPath,
  });

  const result = await runSubagent(prompt, ctx.cwd, {
    tools: ["read", "write", "bash"],
  });

  const report = parseJson(result.output);
  const summary = report?.summary || `任务 ${task.id} 已完成`;

  // 更新状态为 done
  let updated = updateTaskStatus(taskFile, task.id, "done");
  updated = updateTaskSummary(updated, task.id, summary);
  updated = advanceToNextTask(updated);
  await writeTaskFile(piDir, updated);

  // 间隙分析
  await handleGapAnalysis(pi, piDir, updated, task, ctx);
}
```

- [ ] **Step 11: 实现 handleTaskDone 和 handleGapAnalysis — 间隙分析**

```typescript
async function handleTaskDone(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: any,
): Promise<void> {
  // 已经 done，推进到下一个任务
  const updated = advanceToNextTask(taskFile);
  await writeTaskFile(piDir, updated);

  if (allTasksDone(updated)) {
    await handleFinalValidation(pi, piDir, updated, ctx);
  } else {
    pi.sendUserMessage("进入下一个任务。", { deliverAs: "followUp" });
  }
}

async function handleGapAnalysis(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  completedTask: Task,
  ctx: any,
): Promise<void> {
  const nextTask = getCurrentTask(taskFile);

  if (!nextTask) {
    // 没有下一个任务，最终验收
    if (allTasksDone(taskFile)) {
      await handleFinalValidation(pi, piDir, taskFile, ctx);
    }
    return;
  }

  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = await buildCompletedSummaries(taskFile);

  const prompt = await loadPrompt(piDir, "gap-analysis", {
    goal: taskFile.goal,
    projectSpec,
    completedTaskId: completedTask.id,
    completedTaskTitle: completedTask.title,
    completedTaskSummary: completedTask.summary || "",
    nextTaskId: nextTask.id,
    nextTaskTitle: nextTask.title,
    completedSummaries,
  });

  const result = await runSubagent(prompt, ctx.cwd, {
    tools: ["read", "bash"],
  });

  const gap = parseJson(result.output);

  if (gap && gap.needsIntermediateTasks && Array.isArray(gap.tasks) && gap.tasks.length > 0) {
    const updated = insertTasksAfter(taskFile, completedTask.id, gap.tasks);
    // 更新 currentTaskId 到第一个新插入的任务
    const firstNewTask = updated.tasks.find((t) => t.status === "pending");
    if (firstNewTask) {
      const finalUpdated = { ...updated, currentTaskId: firstNewTask.id };
      await writeTaskFile(piDir, finalUpdated);
      pi.sendUserMessage(`间隙分析完成，已插入 ${gap.tasks.length} 个中间任务。`, {
        deliverAs: "followUp",
      });
    }
  } else {
    pi.sendUserMessage(
      `任务 ${completedTask.id} 完成。进入下一个任务：${nextTask.id} - ${nextTask.title}`,
      { deliverAs: "followUp" },
    );
  }
}
```

- [ ] **Step 12: 实现 handleFinalValidation — 最终验收**

```typescript
async function handleFinalValidation(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: any,
): Promise<void> {
  const spec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = await buildCompletedSummaries(taskFile);

  const prompt = [
    "## 最终验收",
    "",
    "所有任务已完成。请验证是否满足总目标 spec。",
    "",
    "### 总目标 Spec",
    spec,
    "",
    "### 已完成任务摘要",
    completedSummaries,
    "",
    "### 要求",
    '如果满足 spec，请告知"验收通过"。',
    "如果不满足，请说明哪些方面不足，需要补充哪些任务。",
  ].join("\n");

  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
  } else {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }
}
```

- [ ] **Step 13: 实现工具函数**

````typescript
function buildCompletedSummaries(taskFile: TaskFile): string {
  const done = taskFile.tasks.filter((t) => t.status === "done");
  if (done.length === 0) return "(暂无已完成任务)";

  return done.map((t) => `- [${t.id}] ${t.title}: ${t.summary || "(无摘要)"}`).join("\n");
}

function parseJson(text: string): any {
  // 尝试直接解析
  try {
    return JSON.parse(text.trim());
  } catch {
    // 尝试从 markdown 代码块中提取
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        return null;
      }
    }
    // 尝试找到第一个 { 到最后一个 }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
````

- [ ] **Step 14: 删除旧的 agent-loop.ts 并 commit**

```bash
rm .pi/extensions/agent-loop.ts
git add .pi/extensions/task-loop.ts .pi/extensions/agent-loop.ts .pi/lib/
git commit -m "feat(task-loop): add core task-loop extension with state machine"
```

---

## Chunk 4: 集成与配置

### Task 6: 更新 auto-lint.ts

**Files:**

- Modify: `.pi/extensions/auto-lint.ts`

- [ ] **Step 1: 移除 auto-lint.ts 中的独立检查逻辑**

task-loop.ts 的 `handleTaskInProgress` 已经包含了硬编码检查。auto-lint.ts 应该只在非任务模式下工作（即 task.json 不存在时）。

```typescript
// 在 auto-lint.ts 的 agent_end handler 中添加条件
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 在 agent_end 中添加：
const taskFilePath = join(ctx.cwd, ".pi", "task.json");
try {
  await readFile(taskFilePath, "utf8");
  // task.json 存在，task-loop.ts 会处理检查
  filesModified = false;
  return;
} catch {
  // task.json 不存在，继续原有逻辑
}
```

- [ ] **Step 2: Commit**

```bash
git add .pi/extensions/auto-lint.ts
git commit -m "refactor(auto-lint): skip when task-loop is active"
```

---

### Task 7: 更新 .gitignore 和 package.json

**Files:**

- Modify: `.gitignore`
- Modify: `.pi/package.json`

- [ ] **Step 1: 更新 .gitignore**

添加 `task.json` 和运行时生成的任务文件到 .gitignore（或者不 ignore，取决于是否需要持久化）。

根据设计，task.json 应该提交到 git 以支持中断恢复，所以不需要 ignore。

但 agent-loop.txt 仍然 ignore（用户特定）。

- [ ] **Step 2: 更新 .pi/package.json 添加依赖**

确认 `@mariozechner/pi-coding-agent` 已在 dependencies 中（已有）。

- [ ] **Step 3: Commit**

```bash
git add .gitignore .pi/package.json
git commit -m "chore: update gitignore and package.json for task-loop"
```

---

## Chunk 5: 最终检查

### Task 8: 验证

- [ ] **Step 1: 运行 typecheck**

```bash
cd .pi && pnpm typecheck
```

Expected: PASS

- [ ] **Step 2: 验证文件结构**

```bash
find .pi -type f -not -path '*/node_modules/*' | sort
```

Expected:

```
.pi/agent-loop.txt
.pi/extensions/auto-lint.ts
.pi/extensions/task-loop.ts
.pi/lib/prompt-loader.ts
.pi/lib/subagent.ts
.pi/lib/task-state.ts
.pi/package.json
.pi/prompts/brainstorm.md
.pi/prompts/gap-analysis.md
.pi/prompts/generate-report.md
.pi/prompts/plan.md
.pi/prompts/prepare-task.md
.pi/prompts/reflect-size.md
.pi/prompts/verify-quality.md
.pi/tsconfig.json
```

- [ ] **Step 3: 手动测试 — 写入 agent-loop.txt 触发循环**

在 `agent-loop.txt` 中写入一个简单目标，启动 pi，验证：

1. task.json 被创建
2. 头脑风暴 prompt 被注入
3. 交互后 spec.md 被生成
4. 任务计划被生成

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete task-loop system implementation"
```

---

**Plan complete and saved to `.pi/task/2025-03-25-task-loop-system-plan.md`. Ready to execute?**

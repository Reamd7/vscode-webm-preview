/**
 * task-guard.ts — 任务状态访问控制 Extension
 *
 * 职责：
 * 1. 注册 `task_state` 自定义 tool，提供结构化的任务状态读取接口
 * 2. 根据当前任务阶段，动态拦截对 .pi/task.json 和 .pi/task/ 目录的非法访问
 *
 * 权限矩阵（根据 task.json 的 status + currentTask.status 动态决定）：
 *
 * ┌────────────────────────┬────────┬──────────────────────────────────┬──────────┐
 * │ 文件                   │ read   │ write/edit                       │ 备注     │
 * ├────────────────────────┼────────┼──────────────────────────────────┼──────────┤
 * │ .pi/task.json           │ ❌     │ ❌                               │ 用 tool  │
 * │ .pi/task/spec.md        │ ✅     │ ✅ 仅 brainstorming 阶段        │ 总 spec  │
 * │ .pi/task/{当前}/spec.md │ ✅     │ ❌                               │ 任务spec │
 * │ .pi/task/{当前}/*       │ ✅     │ ❌                               │          │
 * │ .pi/task/{其他}/*       │ ✅     │ ❌                               │          │
 * │ .pi/task/设计文档等     │ ✅     │ ❌                               │ 只读参考 │
 * └────────────────────────┴────────┴──────────────────────────────────┴──────────┘
 *
 * 设计原则：
 * - task.json 永远禁止直接访问（通过 task_state tool 查看）
 * - .pi/task/ 下的文件默认允许读取（LLM 需要读 spec 来实施任务）
 * - .pi/task/ 下的写入根据阶段控制：
 *   - brainstorming 阶段：允许写入 .pi/task/spec.md（主 agent 生成总 spec）
 *   - 其他情况：所有写入由 subagent/extension 管理，主 agent 不能直接写
 */

import { join, resolve, normalize } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readTaskFile, buildCompletedSummaries, type TaskFile } from "../lib/task-state.js";

// ===========================================================================
// 路径分析
// ===========================================================================

type ProtectedPathKind =
  | "task_json" // .pi/task.json — 永远禁止
  | "project_spec" // .pi/task/spec.md — brainstorming 可写，其他只读
  | "task_file" // .pi/task/{id}/* — 只读
  | "task_design_doc" // .pi/task/其他文件（设计文档等）— 只读
  | false; // 不受保护

/**
 * 解析一个文件路径属于哪种受保护类型。
 */
function classifyPath(filePath: string, cwd: string): ProtectedPathKind {
  const normalized = normalize(resolve(cwd, filePath)).replace(/\\/g, "/");
  const piDir = normalize(resolve(cwd, ".pi")).replace(/\\/g, "/");

  // .pi/task.json
  if (normalized === `${piDir}/task.json`) return "task_json";

  const taskDirPrefix = `${piDir}/task/`;
  if (!normalized.startsWith(taskDirPrefix)) return false;

  // .pi/task/ 下的路径
  const relative = normalized.slice(taskDirPrefix.length); // e.g. "spec.md", "001/spec.md"

  // .pi/task/spec.md — 总目标 spec
  if (relative === "spec.md") return "project_spec";

  // .pi/task/{id}/* — 任务文件（id 是 3 位数字）
  if (/^\d{3}\//.test(relative)) return "task_file";

  // 其他文件（设计文档、流程图等）
  return "task_design_doc";
}

/**
 * 根据当前任务状态和路径类型，判断写入操作是否允许。
 *
 * 返回 null 表示允许，返回 string 表示拦截原因。
 */
function checkWritePermission(
  pathKind: ProtectedPathKind,
  taskFile: TaskFile | null,
): string | null {
  switch (pathKind) {
    case "task_json":
      return "禁止直接修改 .pi/task.json。请使用 task_state tool 查看任务状态。任务状态由系统自动管理。";

    case "project_spec":
      // brainstorming 阶段允许主 agent 写入总 spec
      if (taskFile && taskFile.status === "brainstorming") return null;
      return "禁止直接修改 .pi/task/spec.md。总目标 spec 仅在头脑风暴阶段可由主 agent 写入。";

    case "task_file":
      return "禁止直接修改 .pi/task/{id}/ 下的文件。任务 spec 和 report 由系统（subagent）自动管理。";

    case "task_design_doc":
      return "禁止直接修改 .pi/task/ 下的文档文件。";

    case false:
      return null;
  }
}

/**
 * 根据当前任务状态和路径类型，判断读取操作是否允许。
 */
function checkReadPermission(pathKind: ProtectedPathKind): string | null {
  if (pathKind === "task_json") {
    return "禁止直接读取 .pi/task.json。请使用 task_state tool（action: view/current/summary）查看任务状态。";
  }
  // 所有其他 .pi/task/ 下的文件允许读取
  return null;
}

/**
 * 检查 bash 命令是否尝试写入受保护路径。
 */
function bashWritesToProtectedPath(command: string): boolean {
  const writePatterns = [
    />\s*.*\.pi[/\\]task\.json/,
    />\s*.*\.pi[/\\]task\//,
    /echo\s.*>\s*.*\.pi[/\\]task/,
    /cp\s.*\.pi[/\\]task/,
    /mv\s.*\.pi[/\\]task/,
    /rm\s.*\.pi[/\\]task/,
    /sed\s.*\.pi[/\\]task/,
  ];
  return writePatterns.some((p) => p.test(command));
}

// ===========================================================================
// Extension 入口
// ===========================================================================

export default function taskGuard(pi: ExtensionAPI): void {
  // ------------------------------------------------------------------
  // 1. 状态感知的访问拦截
  // ------------------------------------------------------------------

  pi.on("tool_call", async (event, ctx) => {
    const input: unknown = event.input;
    if (typeof input !== "object" || input === null) return;

    const cwd = ctx.cwd;

    // ---- read/write/edit 拦截 ----
    if (
      (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") &&
      "path" in input &&
      typeof input.path === "string"
    ) {
      const pathKind = classifyPath(input.path, cwd);
      if (pathKind === false) return; // 不受保护

      if (event.toolName === "read") {
        const reason = checkReadPermission(pathKind);
        if (reason) return { block: true, reason };
        return; // 允许读取
      }

      // write 或 edit
      const piDir = join(cwd, ".pi");
      const taskFile = await readTaskFile(piDir);
      const reason = checkWritePermission(pathKind, taskFile);
      if (reason) return { block: true, reason };
      return; // 允许
    }

    // ---- bash 拦截 ----
    if (event.toolName === "bash" && "command" in input && typeof input.command === "string") {
      if (bashWritesToProtectedPath(input.command)) {
        return {
          block: true,
          reason:
            "禁止通过 bash 修改 .pi/task.json 或 .pi/task/ 下的文件。请使用 task_state tool 查看任务状态。",
        };
      }
    }
  });

  // ------------------------------------------------------------------
  // 2. 注册 task_state 自定义 tool
  // ------------------------------------------------------------------

  pi.registerTool({
    name: "task_state",
    label: "Task State",
    description: "查看当前任务系统的状态。这是访问任务进度的唯一合法方式。",
    promptSnippet: "查看任务系统状态（进度、当前任务、已完成摘要）",
    promptGuidelines: [
      "使用 task_state tool 查看任务进度，不要直接读取 .pi/task.json",
      "不要用 read/write/edit 直接操作 .pi/task.json 或 .pi/task/ 下的状态文件",
      "在 brainstorming 阶段可以直接写入 .pi/task/spec.md（总目标 spec），其他文件不可写",
    ],
    parameters: Type.Object({
      action: StringEnum(["view", "current", "summary"] as const, {
        description:
          "view: 查看完整任务列表和状态; current: 查看当前任务详情; summary: 查看已完成任务摘要",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const piDir = join(ctx.cwd, ".pi");
      const taskFile = await readTaskFile(piDir);

      if (!taskFile) {
        return {
          content: [{ type: "text", text: "任务系统未激活（.pi/task.json 不存在）。" }],
          details: {},
        };
      }

      switch (params.action) {
        case "view":
          return {
            content: [{ type: "text", text: formatTaskView(taskFile) }],
            details: { taskFile },
          };

        case "current":
          return {
            content: [{ type: "text", text: formatCurrentTask(taskFile) }],
            details: { taskFile },
          };

        case "summary":
          return {
            content: [{ type: "text", text: buildCompletedSummaries(taskFile) }],
            details: { taskFile },
          };

        default:
          return {
            content: [{ type: "text", text: `未知 action: ${params.action}` }],
            details: {},
          };
      }
    },
  });
}

// ===========================================================================
// 格式化函数
// ===========================================================================

function formatTaskView(taskFile: TaskFile): string {
  const statusIcon: Record<string, string> = {
    pending: "⏳",
    preparing: "📝",
    reflecting: "🤔",
    ready: "✅",
    in_progress: "🔧",
    verifying: "🔍",
    done: "✅",
  };

  const lines = [
    "## 任务系统状态",
    "",
    `**目标：** ${taskFile.goal}`,
    `**阶段：** ${taskFile.status}`,
    `**当前任务：** ${taskFile.currentTaskId || "(无)"}`,
    "",
    `### 任务列表 (${taskFile.tasks.length} 个)`,
    "",
  ];

  for (const task of taskFile.tasks) {
    const icon = statusIcon[task.status] || "❓";
    const current = task.id === taskFile.currentTaskId ? " ◀ 当前" : "";
    const summary = task.summary ? ` — ${task.summary}` : "";
    lines.push(`${icon} **${task.id}** [${task.status}] ${task.title}${current}${summary}`);
  }

  return lines.join("\n");
}

function formatCurrentTask(taskFile: TaskFile): string {
  if (!taskFile.currentTaskId) {
    return taskFile.status === "completed"
      ? "所有任务已完成。项目状态：completed。"
      : `当前没有进行中的任务。项目阶段：${taskFile.status}`;
  }

  const task = taskFile.tasks.find((t) => t.id === taskFile.currentTaskId);
  if (!task) return `当前任务 ${taskFile.currentTaskId} 未找到。`;

  const lines = [
    "## 当前任务",
    "",
    `**ID：** ${task.id}`,
    `**标题：** ${task.title}`,
    `**状态：** ${task.status}`,
  ];

  if (task.splitFromId) {
    lines.push(`**拆分自：** 任务 ${task.splitFromId}`);
  }

  const done = taskFile.tasks.filter((t) => t.status === "done").length;
  const total = taskFile.tasks.length;
  lines.push("", `**总进度：** ${done}/${total} 完成`);

  return lines.join("\n");
}

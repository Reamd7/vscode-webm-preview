/**
 * task-guard.ts — 任务状态访问控制 Extension
 *
 * 职责：
 * 1. 注册 `task_state` 自定义 tool，提供结构化的任务状态读取/修改接口
 * 2. 拦截 LLM 对 .pi/task.json 和 .pi/task/ 目录下状态文件的直接 read/write/edit/bash 访问
 *
 * 为什么需要？
 * - task.json 是状态机的核心状态文件，直接修改会破坏状态一致性
 * - 任务 spec/report 文件由 subagent 管理，LLM 不应直接修改
 * - 通过 task_state tool 提供受控的只读接口，LLM 可以查看进度但不能篡改
 *
 * 被保护的路径：
 * - .pi/task.json — 任务状态文件（禁止直接读写）
 * - .pi/task/     — 任务 spec 和 report 目录（禁止写入，允许读取 spec）
 */

import { join, resolve, normalize } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readTaskFile, buildCompletedSummaries, type TaskFile } from "../lib/task-state.js";

// ===========================================================================
// 路径保护
// ===========================================================================

/**
 * 判断一个路径是否指向受保护的任务状态文件。
 *
 * 受保护路径：
 * - .pi/task.json（完全禁止）
 * - .pi/task/ 下的所有文件（禁止写入，read 由 tool_call 单独处理）
 */
function isProtectedTaskPath(filePath: string, cwd: string): "task_json" | "task_dir" | false {
  const normalized = normalize(resolve(cwd, filePath)).replace(/\\/g, "/");
  const piDir = normalize(resolve(cwd, ".pi")).replace(/\\/g, "/");

  // .pi/task.json
  const taskJsonPath = `${piDir}/task.json`;
  if (normalized === taskJsonPath) return "task_json";

  // .pi/task/ 下的所有文件
  const taskDirPrefix = `${piDir}/task/`;
  if (normalized.startsWith(taskDirPrefix)) return "task_dir";

  return false;
}

/**
 * 检查 bash 命令是否尝试访问受保护路径。
 * 简单启发式：检测命令中是否包含 task.json 或 .pi/task 路径。
 */
function bashTargetsProtectedPath(command: string): boolean {
  const patterns = [
    /\.pi\/task\.json/,
    /\.pi[/\\]task\.json/,
    /task\.json/, // cat task.json, echo > task.json 等
  ];
  // 只拦截写操作，不拦截纯读（cat/less/head 等允许通过 task_state tool 替代）
  const writePatterns = [
    />\s*.*task\.json/, // > task.json, >> task.json
    /echo\s.*>\s*.*task\.json/, // echo ... > task.json
    /cp\s.*task\.json/, // cp ... task.json
    /mv\s.*task\.json/, // mv ... task.json
    /rm\s.*task\.json/, // rm task.json
    /sed\s.*task\.json/, // sed -i ... task.json
  ];
  return writePatterns.some((p) => p.test(command));
}

// ===========================================================================
// Extension 入口
// ===========================================================================

export default function taskGuard(pi: ExtensionAPI): void {
  // ------------------------------------------------------------------
  // 1. 拦截对受保护文件的直接访问
  // ------------------------------------------------------------------

  pi.on("tool_call", (event) => {
    const input: unknown = event.input;
    if (typeof input !== "object" || input === null) return;

    // 获取 cwd（从 event 中拿不到，用 process.cwd() 兜底）
    const cwd = process.cwd();

    // ---- read/write/edit 拦截 ----
    if (
      (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") &&
      "path" in input &&
      typeof input.path === "string"
    ) {
      const protection = isProtectedTaskPath(input.path, cwd);

      if (protection === "task_json") {
        return {
          block: true,
          reason: "禁止直接访问 .pi/task.json。请使用 task_state tool 来查看或操作任务状态。",
        };
      }

      if (protection === "task_dir" && (event.toolName === "write" || event.toolName === "edit")) {
        return {
          block: true,
          reason: "禁止直接修改 .pi/task/ 下的文件。任务 spec 和 report 由系统自动管理。",
        };
      }

      // .pi/task/ 下的 read 允许（LLM 需要读取 spec 来实施任务）
    }

    // ---- bash 拦截 ----
    if (event.toolName === "bash" && "command" in input && typeof input.command === "string") {
      if (bashTargetsProtectedPath(input.command)) {
        return {
          block: true,
          reason: "禁止通过 bash 直接修改 task.json。请使用 task_state tool 来查看任务状态。",
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
      "不要用 read/write/edit 直接操作 .pi/task.json 或 .pi/task/ 目录下的状态文件",
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
    ready: "✅",
    in_progress: "🔧",
    verifying: "🔍",
    done: "✅",
  };

  const lines = [
    `## 任务系统状态`,
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
    `## 当前任务`,
    "",
    `**ID：** ${task.id}`,
    `**标题：** ${task.title}`,
    `**状态：** ${task.status}`,
  ];

  if (task.splitFromId) {
    lines.push(`**拆分自：** 任务 ${task.splitFromId}`);
  }

  // 进度统计
  const done = taskFile.tasks.filter((t) => t.status === "done").length;
  const total = taskFile.tasks.length;
  lines.push("", `**总进度：** ${done}/${total} 完成`);

  return lines.join("\n");
}

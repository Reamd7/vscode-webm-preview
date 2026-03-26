/**
 * task-loop.ts — 核心 Extension：状态驱动的自循环任务系统
 *
 * 核心不变量：
 * **每个异步操作（subagent / 硬编码检查）执行前，必须先写入一个"正在进行"的状态。**
 * **dispatch 遇到"正在进行"状态时，原地重跑该操作（中断恢复）。**
 *
 * 这保证了：
 * 1. 正常流程中不会重入（因为状态已经推进到下一步）
 * 2. 中断恢复时可以从"正在进行"状态安全重试（subagent 调用都是幂等的）
 * 3. 不需要内存中的 hash/flag 等 hack 来防循环
 *
 * 状态机总览：
 *
 * 项目级别：
 *   brainstorming → reviewing_spec → planning → executing → validating → completed
 *   (等待 spec)    (subagent 审查)   (生成计划)  (逐任务)    (最终验收)   (结束)
 *
 * 任务级别：
 *   pending → preparing → reflecting → ready → in_progress → verifying → done
 *   (空标题)  (生成 spec)  (反思规模)   (等实施)  (主 agent)    (检查+审查)  (报告)
 */

import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
  buildCompletedSummaries,
  type TaskFile,
  type Task,
} from "../lib/task-state.js";
import { safeReadFile } from "../lib/prompt-loader.js";
import { loadPrompt } from "../lib/prompt-loader.js";

// ---- Subagent 模块 ----
import { reviewSpec } from "../agents/review-spec/index.js";
import { reviewPlan } from "../agents/review-plan/index.js";
import { generatePlan } from "../agents/plan/index.js";
import { reflectSize } from "../agents/reflect-size/index.js";
import { reviewSpecCompliance } from "../agents/review-spec-compliance/index.js";
import { reviewCodeQuality } from "../agents/review-code-quality/index.js";
import { generateReport } from "../agents/generate-report/index.js";
import { analyzeGap } from "../agents/gap-analysis/index.js";
import { validateProject } from "../agents/final-validation/index.js";
import { prepareTask } from "../agents/prepare-task/index.js";
import type { SubagentEvent } from "../lib/subagent.js";

// ===========================================================================
// Subagent 进度追踪
// ===========================================================================

/** ctx.ui.setStatus 使用的固定 key */
const STATUS_KEY = "subagent";

/**
 * 创建一个 onEvent 回调，将 subagent 事件映射到 ctx.ui.setStatus。
 *
 * 显示格式：`[agentLabel] 正在思考...` / `[agentLabel] > read file.ts` / 等
 *
 * @param ctx   - ExtensionContext，用于访问 ctx.ui.setStatus
 * @param label - 人类可读的 subagent 名称（如 "审查 Spec"、"生成计划"）
 */
function createProgressHandler(
  ctx: ExtensionContext,
  label: string,
): (event: SubagentEvent) => void {
  // 启动时立即显示
  ctx.ui.setStatus(STATUS_KEY, `⏳ [${label}] 正在启动...`);

  return (event: SubagentEvent) => {
    switch (event.type) {
      case "text_delta":
        // 显示最新文本片段（截断到合理长度）
        {
          const snippet = event.text.replace(/\s+/g, " ").trim();
          if (snippet) {
            const display = snippet.length > 60 ? `${snippet.slice(0, 57)}...` : snippet;
            ctx.ui.setStatus(STATUS_KEY, `⏳ [${label}] ${display}`);
          }
        }
        break;
      case "tool_start":
        ctx.ui.setStatus(
          STATUS_KEY,
          `⏳ [${label}] > ${event.toolName}${formatToolArgs(event.args)}`,
        );
        break;
      case "tool_end":
        ctx.ui.setStatus(STATUS_KEY, `⏳ [${label}] 正在思考...`);
        break;
      case "turn_start":
        if (event.turnIndex > 0) {
          ctx.ui.setStatus(STATUS_KEY, `⏳ [${label}] 回合 ${event.turnIndex + 1}...`);
        }
        break;
      case "turn_end":
        break;
    }
  };
}

/**
 * 清除 subagent 状态显示。
 */
function clearProgress(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
}

/**
 * 在 subagent 调用期间显示进度，结束后自动清除。
 *
 * @param ctx   - ExtensionContext
 * @param label - 人类可读的 subagent 名称
 * @param fn    - 接收 onEvent 回调的异步函数（即 subagent 调用）
 */
async function withProgress<T>(
  ctx: ExtensionContext,
  label: string,
  fn: (onEvent: (event: SubagentEvent) => void) => Promise<T>,
): Promise<T> {
  const handler = createProgressHandler(ctx, label);
  try {
    return await fn(handler);
  } finally {
    clearProgress(ctx);
  }
}

/**
 * 格式化 tool 参数为简短描述（用于状态行）。
 */
function formatToolArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  // read/write: 显示文件路径
  if (typeof args.filePath === "string") {
    const path = args.filePath as string;
    // 只显示最后两级路径
    const parts = path.replace(/\\/g, "/").split("/");
    const short = parts.length > 2 ? parts.slice(-2).join("/") : path;
    return ` ${short}`;
  }
  // bash: 显示命令片段
  if (typeof args.command === "string") {
    const cmd = (args.command as string).trim();
    const display = cmd.length > 40 ? `${cmd.slice(0, 37)}...` : cmd;
    return ` \`${display}\``;
  }
  return "";
}

// ===========================================================================
// Extension 入口
// ===========================================================================

export default function taskLoop(pi: ExtensionAPI): void {
  // subagent 中不需要任务循环逻辑（避免 agent_end 重入、命令注册等）
  if (process.env.PI_SUBAGENT) return;

  /**
   * 追踪当前回合是否有文件变更。
   * 只有 in_progress 状态下有文件变更才会触发 verifying。
   */
  let filesModified = false;

  /**
   * 追踪当前任务的修复循环次数。
   * 超过 2 次修复失败后注入系统化调试指导。
   */
  let fixAttempts = 0;
  let fixAttemptsTaskId: string | null = null;

  // ---- /task-loop 命令：以 prompt 直接启动任务循环 ----
  pi.registerCommand("task-loop", {
    description: "Start the task loop with a prompt as the goal",
    handler: async (args, ctx) => {
      const prompt = args?.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /task-loop <prompt>", "warning");
        return;
      }

      const piDir = join(ctx.cwd, ".pi");
      const existing = await readTaskFile(piDir);
      if (existing) {
        ctx.ui.notify(
          "Task loop already active (task.json exists). Use /task-loop after removing .pi/task.json to start fresh.",
          "warning",
        );
        return;
      }

      // 写入 agent-loop.txt（持久化 goal，供中断恢复使用）
      await mkdir(piDir, { recursive: true });
      await writeFile(join(piDir, "agent-loop.txt"), prompt, "utf8");

      // 创建 task.json (brainstorming) 并发送 brainstorm prompt
      const taskFile = createTaskFile(prompt);
      await writeTaskFile(piDir, taskFile);

      const brainstormPrompt = await loadPrompt(piDir, "brainstorm", {
        goal: prompt,
        specPath: join(piDir, "task", "spec.md"),
      });

      sendMessage(pi, ctx, brainstormPrompt);
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      filesModified = true;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const piDir = join(ctx.cwd, ".pi");
    const taskFile = await readTaskFile(piDir);

    if (!taskFile) return;

    switch (taskFile.status) {
      case "brainstorming":
        await handleBrainstorming(pi, piDir, taskFile, ctx);
        break;

      case "reviewing_spec":
        // 中断恢复：进程在 subagent 审查期间被杀，原地重跑
        await handleBrainstorming(pi, piDir, taskFile, ctx);
        break;

      case "planning":
        // 中断恢复：如果 tasks 已有，推进到 executing；否则重跑计划生成
        if (taskFile.tasks.length > 0) {
          const updated: TaskFile = {
            ...taskFile,
            status: "executing",
            currentTaskId: taskFile.currentTaskId || taskFile.tasks[0].id,
          };
          await writeTaskFile(piDir, updated);
          pi.sendUserMessage("进入执行阶段。", { deliverAs: "followUp" });
        } else {
          const specPath = join(piDir, "task", "spec.md");
          const spec = (await safeReadFile(specPath)).trim();
          if (spec) {
            await generateAndReviewPlan(pi, piDir, taskFile, spec, ctx);
          } else {
            // spec 也不存在 → 回退到 brainstorming
            await writeTaskFile(piDir, { ...taskFile, status: "brainstorming" });
            pi.sendUserMessage("计划生成被中断且 spec 缺失，回退到 brainstorming。", {
              deliverAs: "followUp",
            });
          }
        }
        break;

      case "executing": {
        const currentId = taskFile.currentTaskId;
        if (currentId !== fixAttemptsTaskId) {
          fixAttempts = 0;
          fixAttemptsTaskId = currentId;
        }
        const result = await handleExecuting(pi, piDir, taskFile, ctx, filesModified, fixAttempts);
        filesModified = false;
        if (result === "fix_failed") fixAttempts++;
        else if (result === "fix_passed") fixAttempts = 0;
        break;
      }

      case "validating":
        // 中断恢复：进程在最终验收 subagent 期间被杀，原地重跑
        await handleFinalValidation(pi, piDir, taskFile, ctx);
        break;

      case "completed":
        break;
    }
  });
}

// ===========================================================================
// 项目级别 handlers
// ===========================================================================

/**
 * brainstorming：等待 spec.md → 转 reviewing_spec → 跑审查。
 *
 * 关键：先写 reviewing_spec 再跑 subagent。
 * 这样下一个 agent_end 读到 reviewing_spec 就会跳过（noop）。
 * 审查完成后根据结果：
 * - 不通过 → 回到 brainstorming（等主 agent 修改 spec）
 * - 通过 → 转 planning → 跑计划生成
 */
async function handleBrainstorming(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
): Promise<void> {
  const specPath = join(piDir, "task", "spec.md");
  const spec = (await safeReadFile(specPath)).trim();
  if (!spec) return; // spec 还没写完，继续等

  // ---- 防止对同一份 spec 重复审查 ----
  // 场景：审查不通过 → brainstorming → agent 回应但没改 spec → agent_end → 又审查
  // 用 spec 内容的哈希避免：只有 spec 实际变化后才重新审查。
  // 注意：这不是替代状态机的 hack，而是对"brainstorming 状态下 spec 已存在"
  // 这个特定边界条件的幂等保护。状态机保证不会重入 reviewing_spec，
  // 但无法区分"spec 没变的 brainstorming"和"spec 改了的 brainstorming"。
  const { createHash } = await import("node:crypto");
  const specHash = createHash("sha256").update(spec).digest("hex");
  if (taskFile._lastReviewedSpecHash === specHash) return;

  // ---- 先写状态，再跑 subagent ----
  await writeTaskFile(piDir, { ...taskFile, status: "reviewing_spec" });

  const review = await withProgress(ctx, "审查 Spec", (onEvent) =>
    reviewSpec(spec, ctx.cwd, onEvent),
  );

  if (
    review &&
    review.approved === false &&
    Array.isArray(review.issues) &&
    review.issues.length > 0
  ) {
    // 审查不通过 → 回到 brainstorming，记录已审查的 spec hash 防重复
    await writeTaskFile(piDir, {
      ...taskFile,
      status: "brainstorming",
      _lastReviewedSpecHash: specHash,
    });

    const issueList = review.issues
      .map(
        (i: { section: string; issue: string; reason: string }) =>
          `- **${i.section}**: ${i.issue}（${i.reason}）`,
      )
      .join("\n");
    pi.sendUserMessage(`Spec 审查未通过，请修改 \`${specPath}\` 后继续：\n\n${issueList}`, {
      deliverAs: "followUp",
    });
    return;
  }

  // ---- spec 审查通过 → planning → 生成计划 ----
  await writeTaskFile(piDir, { ...taskFile, status: "planning" });

  await generateAndReviewPlan(pi, piDir, taskFile, spec, ctx);
}

/**
 * 生成任务计划 + 审查。在 planning 状态下运行。
 *
 * 这是一个同步流程（不会被 agent_end 重入，因为状态已经是 planning）：
 * 1. subagent 生成计划
 * 2. subagent 审查计划
 * 3. 不通过 → 带反馈重新生成一次（最多一次重试）
 * 4. 写入 tasks → executing
 */
async function generateAndReviewPlan(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  spec: string,
  ctx: ExtensionContext,
): Promise<void> {
  const context = buildCompletedSummaries(taskFile);

  const plan = await withProgress(ctx, "生成计划", (onEvent) =>
    generatePlan(taskFile.goal, spec, context, ctx.cwd, onEvent),
  );

  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    // 生成失败 → 回到 brainstorming 让用户调整
    await writeTaskFile(piDir, { ...taskFile, status: "brainstorming" });
    pi.sendUserMessage("任务计划生成失败，请调整 spec 后重试。", { deliverAs: "followUp" });
    return;
  }

  // 审查计划
  const planReview = await withProgress(ctx, "审查计划", (onEvent) =>
    reviewPlan(taskFile.goal, spec, JSON.stringify(plan.tasks, null, 2), ctx.cwd, onEvent),
  );

  let finalTasks = plan.tasks;

  if (
    planReview &&
    planReview.approved === false &&
    Array.isArray(planReview.issues) &&
    planReview.issues.length > 0
  ) {
    // 审查不通过 → 带反馈重试一次
    const issueList = planReview.issues
      .map(
        (i: { section: string; issue: string; reason: string }) =>
          `- ${i.section}: ${i.issue}（${i.reason}）`,
      )
      .join("\n");

    const retryContext = `${context}\n\n## 上一版计划的审查意见（请根据意见修改）\n\n${issueList}`;
    const retryPlan = await withProgress(ctx, "重新生成计划", (onEvent) =>
      generatePlan(taskFile.goal, spec, retryContext, ctx.cwd, onEvent),
    );

    if (retryPlan && Array.isArray(retryPlan.tasks) && retryPlan.tasks.length > 0) {
      finalTasks = retryPlan.tasks;
    }
    // 如果重试也失败，用原始计划（总比没有好）
  }

  // 写入 tasks → executing
  const planned: TaskFile = {
    ...taskFile,
    status: "executing",
    tasks: finalTasks.map((t: { title: string }, i: number) => ({
      id: String(i + 1).padStart(3, "0"),
      title: t.title,
      status: "pending" as const,
      summary: null,
    })),
    currentTaskId: "001",
  };
  await writeTaskFile(piDir, planned);

  pi.sendUserMessage(`任务计划已生成，共 ${planned.tasks.length} 个任务。开始执行第一个任务。`, {
    deliverAs: "followUp",
  });
}

// ===========================================================================
// 执行阶段 dispatch
// ===========================================================================

/**
 * executing 阶段：根据当前任务状态分发。
 *
 * 关键规则：
 * - preparing / reflecting / verifying 都是"正在进行"状态 → noop
 * - 只有稳定状态（pending / ready / in_progress / done）才触发动作
 */
async function handleExecuting(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
  filesModified: boolean,
  fixAttempts: number,
): Promise<"fix_failed" | "fix_passed" | undefined> {
  const current = getCurrentTask(taskFile);

  if (!current) {
    if (allTasksDone(taskFile)) {
      await handleFinalValidation(pi, piDir, taskFile, ctx);
    }
    return;
  }

  switch (current.status) {
    case "pending":
      await handleTaskPending(pi, piDir, taskFile, current, ctx);
      return "fix_passed";

    case "preparing":
      // subagent 正在生成 spec，noop
      // 中断恢复：如果 spec 文件已存在，推进到 reflecting
      await recoverPreparing(pi, piDir, taskFile, current, ctx);
      return;

    case "reflecting":
      // 中断恢复：进程在 reflect subagent 期间被杀，原地重跑
      await recoverReflecting(pi, piDir, taskFile, current, ctx);
      return;

    case "ready":
      await handleTaskReady(pi, piDir, taskFile, current, ctx);
      return "fix_passed";

    case "in_progress":
      return await handleTaskInProgress(
        pi,
        piDir,
        taskFile,
        current,
        ctx,
        filesModified,
        fixAttempts,
      );

    case "verifying":
      // 硬编码检查 + subagent 审查正在进行，noop
      // 中断恢复：退回 in_progress 等下一次文件变更
      await recoverVerifying(pi, piDir, taskFile, current);
      return;

    case "done":
      await handleTaskDone(pi, piDir, taskFile, current, ctx);
      return "fix_passed";
  }
}

// ===========================================================================
// 任务级别 handlers
// ===========================================================================

/**
 * pending → preparing → (subagent 生成 spec) → reflecting → (subagent 反思) → ready/split
 *
 * 整个 pending 到 ready 的流程在一次 handler 调用中完成：
 * 1. 写 preparing（防重入）
 * 2. subagent 生成 spec
 * 3. 写 reflecting（防重入）
 * 4. subagent 反思规模
 * 5. 写 ready 或 split
 */
async function handleTaskPending(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  // ---- 阶段 1：preparing（生成 spec）----
  const preparing = updateTaskStatus(taskFile, task.id, "preparing");
  await writeTaskFile(piDir, preparing);

  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = buildCompletedSummaries(taskFile);
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");

  let parentSpec = "";
  if (task.splitFromId) {
    parentSpec = await safeReadFile(join(piDir, "task", task.splitFromId, "spec.md"));
  }

  await withProgress(ctx, `准备任务 ${task.id}`, (onEvent) =>
    prepareTask(
      {
        goal: taskFile.goal,
        projectSpec,
        taskId: task.id,
        taskTitle: task.title,
        completedSummaries,
        taskSpecPath,
        parentSpec,
      },
      ctx.cwd,
      onEvent,
    ),
  );

  // ---- 阶段 2：reflecting（反思规模）----
  const reflecting = updateTaskStatus(preparing, task.id, "reflecting");
  await writeTaskFile(piDir, reflecting);

  const taskSpec = (await safeReadFile(taskSpecPath)).trim();
  if (!taskSpec) {
    // spec 生成失败 — 追踪重试次数，超过 3 次则跳过该任务
    const attempts = (task.prepareAttempts || 0) + 1;
    if (attempts >= 3) {
      let updated = updateTaskStatus(reflecting, task.id, "done");
      updated = updateTaskSummary(updated, task.id, `跳过：spec 生成连续失败 ${attempts} 次`);
      updated = advanceToNextTask(updated);
      await writeTaskFile(piDir, updated);
      pi.sendUserMessage(`⚠️ 任务 ${task.id} 的 spec 生成连续失败 ${attempts} 次，已跳过。`, {
        deliverAs: "followUp",
      });
      return;
    }

    // 回到 pending，记录重试次数
    const reverted: TaskFile = {
      ...reflecting,
      tasks: reflecting.tasks.map((t) =>
        t.id === task.id ? { ...t, status: "pending" as const, prepareAttempts: attempts } : t,
      ),
    };
    await writeTaskFile(piDir, reverted);
    pi.sendUserMessage(`任务 ${task.id} 的 spec 生成失败（第 ${attempts} 次），将在下一轮重试。`, {
      deliverAs: "followUp",
    });
    return;
  }

  const reflection = await withProgress(ctx, `评估任务 ${task.id} 规模`, (onEvent) =>
    reflectSize(taskSpec, ctx.cwd, onEvent),
  );

  if (
    reflection?.feasible === false &&
    Array.isArray(reflection.tasks) &&
    reflection.tasks.length > 0
  ) {
    // 任务太大，拆分
    const updated = splitTask(reflecting, task.id, reflection.tasks);
    await writeTaskFile(piDir, { ...updated, status: "executing" });
    pi.sendUserMessage(`任务 ${task.id} 过大，已拆分为 ${reflection.tasks.length} 个子任务。`, {
      deliverAs: "followUp",
    });
  } else {
    // 任务可行 → ready
    const updated = updateTaskStatus(reflecting, task.id, "ready");
    await writeTaskFile(piDir, updated);
    pi.sendUserMessage(
      `任务 ${task.id}（${task.title}）已就绪，开始实施。\n\n请阅读任务 spec：${taskSpecPath}`,
      { deliverAs: "followUp" },
    );
  }
}

/**
 * 中断恢复：如果 preparing 状态下 spec 已存在，推进到 reflecting 继续。
 */
async function recoverPreparing(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");
  const taskSpec = (await safeReadFile(taskSpecPath)).trim();
  if (!taskSpec) return; // spec 还没生成完，继续等

  // spec 已存在但状态还是 preparing → subagent 完成了但状态没推进
  // 进入 reflecting 继续
  const reflecting = updateTaskStatus(taskFile, task.id, "reflecting");
  await writeTaskFile(piDir, reflecting);

  const reflection = await withProgress(ctx, `评估任务 ${task.id} 规模`, (onEvent) =>
    reflectSize(taskSpec, ctx.cwd, onEvent),
  );

  if (
    reflection?.feasible === false &&
    Array.isArray(reflection.tasks) &&
    reflection.tasks.length > 0
  ) {
    const updated = splitTask(reflecting, task.id, reflection.tasks);
    await writeTaskFile(piDir, { ...updated, status: "executing" });
    pi.sendUserMessage(`任务 ${task.id} 过大，已拆分为 ${reflection.tasks.length} 个子任务。`, {
      deliverAs: "followUp",
    });
  } else {
    const updated = updateTaskStatus(reflecting, task.id, "ready");
    await writeTaskFile(piDir, updated);
    pi.sendUserMessage(
      `任务 ${task.id}（${task.title}）已就绪，开始实施。\n\n请阅读任务 spec：${taskSpecPath}`,
      { deliverAs: "followUp" },
    );
  }
}

/**
 * 中断恢复：reflecting 状态下重跑 reflectSize subagent。
 *
 * 如果 spec 不存在，回退到 pending 重试（和 handleTaskPending 的失败逻辑一致）。
 * 如果 spec 存在，直接重跑 reflectSize。
 */
async function recoverReflecting(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");
  const taskSpec = (await safeReadFile(taskSpecPath)).trim();

  if (!taskSpec) {
    // spec 不存在 → 回退到 pending 重新走 preparing 流程
    const reverted = updateTaskStatus(taskFile, task.id, "pending");
    await writeTaskFile(piDir, reverted);
    pi.sendUserMessage(`任务 ${task.id} 的 reflecting 被中断且 spec 缺失，回退到 pending 重试。`, {
      deliverAs: "followUp",
    });
    return;
  }

  const reflection = await withProgress(ctx, `评估任务 ${task.id} 规模`, (onEvent) =>
    reflectSize(taskSpec, ctx.cwd, onEvent),
  );

  if (
    reflection?.feasible === false &&
    Array.isArray(reflection.tasks) &&
    reflection.tasks.length > 0
  ) {
    const updated = splitTask(taskFile, task.id, reflection.tasks);
    await writeTaskFile(piDir, { ...updated, status: "executing" });
    pi.sendUserMessage(`任务 ${task.id} 过大，已拆分为 ${reflection.tasks.length} 个子任务。`, {
      deliverAs: "followUp",
    });
  } else {
    const updated = updateTaskStatus(taskFile, task.id, "ready");
    await writeTaskFile(piDir, updated);
    pi.sendUserMessage(
      `任务 ${task.id}（${task.title}）已就绪，开始实施。\n\n请阅读任务 spec：${taskSpecPath}`,
      { deliverAs: "followUp" },
    );
  }
}

/**
 * 中断恢复：verifying 状态退回 in_progress。
 *
 * 如果中断在 verifying 阶段恢复，验证过程不完整，
 * 退回 in_progress 并通知 agent 继续工作。
 * 不发消息会导致 agent 静默卡死（in_progress + filesModified=false = noop）。
 */
async function recoverVerifying(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
): Promise<void> {
  const reverted = updateTaskStatus(taskFile, task.id, "in_progress");
  await writeTaskFile(piDir, reverted);
  pi.sendUserMessage(
    `任务 ${task.id} 的验证过程被中断，已恢复到实施状态。请继续完成任务并提交变更。`,
    { deliverAs: "followUp" },
  );
}

/**
 * ready → in_progress：注入实施 prompt 给主 agent。
 */
async function handleTaskReady(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const updated = updateTaskStatus(taskFile, task.id, "in_progress");
  await writeTaskFile(piDir, updated);

  const taskSpec = await safeReadFile(join(piDir, "task", task.id, "spec.md"));

  const prompt = [
    `## 当前任务: ${task.id} - ${task.title}`,
    "",
    "请阅读以下任务 spec 并实施：",
    "",
    taskSpec,
    "",
    "## TDD 要求（强制）",
    "",
    "严格遵循 Red-Green-Refactor 循环：",
    "1. **RED**：先写一个失败的测试，明确期望行为",
    "2. **验证 RED**：运行测试，确认它以正确的方式失败（缺少功能，而非拼写错误）",
    "3. **GREEN**：写最小实现使测试通过，不要多写",
    "4. **验证 GREEN**：运行测试，确认通过且没有破坏其他测试",
    "5. **REFACTOR**：整理代码，保持测试为绿",
    "6. 对下一个功能点重复以上循环",
    "",
    "**禁止**：先写实现再补测试。如果已经写了实现代码，删掉，从测试重新开始。",
    "",
    "## 质量要求",
    "",
    "- 代码需要通过 lint, typecheck, 测试",
    "- 测试覆盖率 100%",
    "- **必须编写自验证测试（harness）**：针对本任务 spec 中的验收标准，编写测试用例验证你的实现行为是否符合预期",
    "- 测试验证真实行为，不要过度依赖 mock",
    "- 每个测试只测一件事，名字清晰描述行为",
    "",
    "## 完成前验证（强制）",
    "",
    "在声称完成之前，你必须：",
    "1. 运行 `pnpm test` 并确认全部通过",
    "2. 运行 `pnpm typecheck` 并确认无错误",
    "3. 运行 `pnpm lint` 并确认无错误",
    "4. 将以上命令的实际输出贴出来作为证据",
    "",
    "**没有验证证据就不能声称完成。**",
    "",
    "- 完成后告知我",
  ].join("\n");

  sendMessage(pi, ctx, prompt);
}

/**
 * in_progress → verifying → (检查 + 审查) → done 或回到 in_progress。
 *
 * 关键：先写 verifying 再跑检查。
 * 检查/审查完成后：通过 → done，不通过 → in_progress。
 */
async function handleTaskInProgress(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
  filesModified: boolean,
  fixAttempts: number,
): Promise<"fix_failed" | "fix_passed" | undefined> {
  if (!filesModified) return;

  // ---- 先写 verifying 状态 ----
  const verifying = updateTaskStatus(taskFile, task.id, "verifying");
  await writeTaskFile(piDir, verifying);

  // ---- 阶段 1：硬编码检查 ----
  const checks = await runHardcodedChecks(pi);
  if (checks.errors.length > 0) {
    const reverted = updateTaskStatus(verifying, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);

    let message = `硬编码检查未通过，请修复：\n\n${checks.errors.join("\n\n")}`;
    if (fixAttempts >= 2) {
      const debugGuide = await loadPrompt(piDir, "debug-guide", {});
      message += `\n\n---\n\n⚠️ 你已经在这个任务的修复循环中失败了 ${fixAttempts + 1} 次。请按以下指导系统化调试：\n\n${debugGuide}`;
    }

    pi.sendUserMessage(message, { deliverAs: "followUp" });
    return "fix_failed";
  }

  // ---- 阶段 2：LLM 两阶段评审 ----
  const passed = await handleQualityReflection(pi, piDir, verifying, task, ctx, fixAttempts);
  return passed ? "fix_passed" : "fix_failed";
}

/**
 * done → 推进到下一个任务。
 */
async function handleTaskDone(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  _task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const updated = advanceToNextTask(taskFile);
  await writeTaskFile(piDir, updated);

  if (allTasksDone(updated)) {
    await handleFinalValidation(pi, piDir, updated, ctx);
  } else {
    pi.sendUserMessage("进入下一个任务。", { deliverAs: "followUp" });
  }
}

// ===========================================================================
// 质量验证 & 报告生成
// ===========================================================================

/**
 * 两阶段评审：spec 一致性 → 代码质量。
 *
 * 此时状态已经是 verifying（由 handleTaskInProgress 写入），
 * 所以 agent_end 重入时会 noop。
 *
 * 返回 true = 通过，false = 需要修复。
 */
async function handleQualityReflection(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
  fixAttempts: number,
): Promise<boolean> {
  const taskSpec = await safeReadFile(join(piDir, "task", task.id, "spec.md"));
  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10_000 });
  const gitDiff = await pi.exec("git", ["diff"], { timeout: 10_000 });

  // ---- 阶段 1：Spec 一致性审查 ----
  const specReview = await withProgress(ctx, `Spec 一致性审查 (${task.id})`, (onEvent) =>
    reviewSpecCompliance(
      taskSpec,
      gitStatus.stdout || "(clean)",
      gitDiff.stdout || "(no changes)",
      ctx.cwd,
      onEvent,
    ),
  );

  if (specReview && specReview.compliant === false) {
    const reverted = updateTaskStatus(taskFile, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);

    const issues: string[] = [];
    if (specReview.missing?.length)
      issues.push(
        `**缺失的需求：**\n${specReview.missing.map((m: string) => `- ${m}`).join("\n")}`,
      );
    if (specReview.extra?.length)
      issues.push(`**多余的实现：**\n${specReview.extra.map((e: string) => `- ${e}`).join("\n")}`);
    if (specReview.misunderstandings?.length)
      issues.push(
        `**理解偏差：**\n${specReview.misunderstandings.map((m: string) => `- ${m}`).join("\n")}`,
      );
    if (specReview.harnessExists === false)
      issues.push("**缺少 harness 测试**：必须编写自验证测试");

    let message = `Spec 一致性审查未通过，请修复后继续：\n\n${issues.join("\n\n")}`;
    if (fixAttempts >= 2) {
      const debugGuide = await loadPrompt(piDir, "debug-guide", {});
      message += `\n\n---\n\n⚠️ 修复循环第 ${fixAttempts + 1} 次。请系统化调试：\n\n${debugGuide}`;
    }

    pi.sendUserMessage(message, { deliverAs: "followUp" });
    return false;
  }

  // ---- 阶段 2：代码质量审查 ----
  const qualityReview = await withProgress(ctx, `代码质量审查 (${task.id})`, (onEvent) =>
    reviewCodeQuality(taskSpec, gitDiff.stdout || "(no changes)", ctx.cwd, onEvent),
  );

  if (qualityReview && qualityReview.approved === false) {
    const reverted = updateTaskStatus(taskFile, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);

    const issueList = (qualityReview.issues || [])
      .filter((i: { severity: string }) => i.severity === "critical" || i.severity === "important")
      .map(
        (i: { severity: string; description: string; file: string }) =>
          `- [${i.severity}] ${i.description}${i.file ? ` (${i.file})` : ""}`,
      )
      .join("\n");

    let message = `代码质量审查未通过，请修复后继续：\n\n${issueList}`;
    if (fixAttempts >= 2) {
      const debugGuide = await loadPrompt(piDir, "debug-guide", {});
      message += `\n\n---\n\n⚠️ 修复循环第 ${fixAttempts + 1} 次。请系统化调试：\n\n${debugGuide}`;
    }

    pi.sendUserMessage(message, { deliverAs: "followUp" });
    return false;
  }

  // ---- 两阶段都通过 → 生成报告 ----
  await handleGenerateReport(pi, piDir, taskFile, task, ctx);
  return true;
}

/**
 * 生成完成报告 + 间隙分析 + 推进。
 *
 * 此时状态是 verifying，所以不会被重入。
 * 完成后直接写 done + advanceToNextTask。
 */
async function handleGenerateReport(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const taskSpec = await safeReadFile(join(piDir, "task", task.id, "spec.md"));
  const reportPath = join(piDir, "task", task.id, "report.md");

  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10_000 });
  const gitDiff = await pi.exec("git", ["diff"], { timeout: 10_000 });
  const gitLog = await pi.exec("git", ["log", "--oneline", "-10"], { timeout: 10_000 });

  const report = await withProgress(ctx, `生成报告 (${task.id})`, (onEvent) =>
    generateReport(
      taskSpec,
      gitStatus.stdout || "(clean)",
      gitDiff.stdout || "(no changes)",
      gitLog.stdout || "(no commits)",
      reportPath,
      ctx.cwd,
      onEvent,
    ),
  );
  const summary = report?.summary || `任务 ${task.id} 已完成`;

  // done + summary + advance — 一次性写入
  let updated = updateTaskStatus(taskFile, task.id, "done");
  updated = updateTaskSummary(updated, task.id, summary);
  updated = advanceToNextTask(updated);
  await writeTaskFile(piDir, updated);

  // 间隙分析
  await handleGapAnalysis(pi, piDir, updated, task, ctx);
}

// ===========================================================================
// 间隙分析
// ===========================================================================

/**
 * 间隙分析：已完成任务 → 下一任务之间是否需要插入中间任务。
 *
 * 在 handleGenerateReport 内同步调用，状态仍在安全的 done+advanced 后。
 */
async function handleGapAnalysis(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  completedTask: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const nextTask = getCurrentTask(taskFile);

  if (!nextTask) {
    if (allTasksDone(taskFile)) {
      await handleFinalValidation(pi, piDir, taskFile, ctx);
    }
    return;
  }

  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = buildCompletedSummaries(taskFile);

  const gap = await withProgress(ctx, "间隙分析", (onEvent) =>
    analyzeGap(
      {
        goal: taskFile.goal,
        projectSpec,
        completedTaskId: completedTask.id,
        completedTaskTitle: completedTask.title,
        completedTaskSummary: completedTask.summary || "",
        nextTaskId: nextTask.id,
        nextTaskTitle: nextTask.title,
        completedSummaries,
      },
      ctx.cwd,
      onEvent,
    ),
  );

  if (gap?.needsIntermediateTasks && Array.isArray(gap.tasks) && gap.tasks.length > 0) {
    const updated = insertTasksAfter(taskFile, completedTask.id, gap.tasks);
    const firstNew = updated.tasks.find((t) => t.status === "pending");
    if (firstNew) {
      await writeTaskFile(piDir, { ...updated, currentTaskId: firstNew.id });
      pi.sendUserMessage(`间隙分析完成，已插入 ${gap.tasks.length} 个中间任务。`, {
        deliverAs: "followUp",
      });
      return;
    }
  }

  pi.sendUserMessage(
    `任务 ${completedTask.id} 完成。进入下一个任务：${nextTask.id} - ${nextTask.title}`,
    { deliverAs: "followUp" },
  );
}

// ===========================================================================
// 最终验收
// ===========================================================================

/**
 * 最终验收：所有任务完成 → validating → subagent 判定。
 *
 * 关键：先写 validating 再跑 subagent。
 * agent_end 读到 validating 就 noop。
 */
/**
 * 最大最终验收尝试次数。
 * 超过后强制标记完成，交给用户手动处理，避免无限追加任务。
 */
const MAX_VALIDATION_ATTEMPTS = 3;

async function handleFinalValidation(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
): Promise<void> {
  const attempts = (taskFile.validationAttempts || 0) + 1;

  // 超过最大尝试次数 → 强制完成
  if (attempts > MAX_VALIDATION_ATTEMPTS) {
    const completed: TaskFile = { ...taskFile, status: "completed", validationAttempts: attempts };
    await writeTaskFile(piDir, completed);
    sendMessage(
      pi,
      ctx,
      `## 最终验收已达上限（${MAX_VALIDATION_ATTEMPTS} 次）\n\n已强制标记为完成。请手动检查是否满足需求。`,
    );
    return;
  }

  // ---- 先写 validating + 递增计数 ----
  await writeTaskFile(piDir, { ...taskFile, status: "validating", validationAttempts: attempts });

  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = buildCompletedSummaries(taskFile);
  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10_000 });

  const validation = await withProgress(ctx, "最终验收", (onEvent) =>
    validateProject(
      taskFile.goal,
      projectSpec,
      completedSummaries,
      gitStatus.stdout || "(clean)",
      ctx.cwd,
      onEvent,
    ),
  );

  if (validation?.passed === true) {
    // 验收通过
    const completed: TaskFile = { ...taskFile, status: "completed" };
    await writeTaskFile(piDir, completed);

    const finishGitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10_000 });
    const finishPrompt = await loadPrompt(piDir, "finish", {
      goal: completed.goal,
      completedSummaries: buildCompletedSummaries(completed),
      gitStatus: finishGitStatus.stdout || "(clean)",
    });

    sendMessage(
      pi,
      ctx,
      `## 验收通过 ✅\n\n${validation.reason || "所有任务已满足 spec。"}\n\n---\n\n${finishPrompt}`,
    );
    return;
  }

  // 验收未通过 → 追加补充任务
  if (validation?.tasks && Array.isArray(validation.tasks) && validation.tasks.length > 0) {
    const lastDone = [...taskFile.tasks].reverse().find((t) => t.status === "done");
    const afterId = lastDone?.id ?? taskFile.tasks[taskFile.tasks.length - 1]?.id;

    if (afterId) {
      const updated = insertTasksAfter(taskFile, afterId, validation.tasks);
      const firstNew = updated.tasks.find((t) => t.status === "pending");
      if (firstNew) {
        await writeTaskFile(piDir, {
          ...updated,
          status: "executing",
          currentTaskId: firstNew.id,
          validationAttempts: 0, // 有新任务了，重置验收计数
        });
        pi.sendUserMessage(
          `最终验收未通过：${validation.reason || ""}\n已追加 ${validation.tasks.length} 个补充任务，继续执行。`,
          { deliverAs: "followUp" },
        );
        return;
      }
    }
  }

  // Fallback：subagent 未返回有效的补充任务 → 强制完成，交给用户
  // 不能回到 executing，否则 allTasksDone → 又进 handleFinalValidation → 死循环
  const completed: TaskFile = { ...taskFile, status: "completed", validationAttempts: attempts };
  await writeTaskFile(piDir, completed);
  sendMessage(
    pi,
    ctx,
    `## 最终验收未通过\n\n${validation?.reason || "未能确定原因。"}\n\n已标记为完成，请手动检查和补充。`,
  );
}

// ===========================================================================
// 硬编码检查
// ===========================================================================

async function runHardcodedChecks(pi: ExtensionAPI): Promise<{ errors: string[] }> {
  const errors: string[] = [];

  const fmtResult = await pi.exec("npx", ["oxfmt", "packages"], { timeout: 30_000 });
  if (fmtResult.code !== 0) {
    const out = [fmtResult.stdout, fmtResult.stderr].filter(Boolean).join("\n").trim();
    if (out) errors.push(`\`oxfmt\` failed (exit ${fmtResult.code}):\n${out}`);
  }

  const lintResult = await pi.exec("npx", ["oxlint", "--fix", "packages"], { timeout: 30_000 });
  if (lintResult.code !== 0) {
    const out = [lintResult.stdout, lintResult.stderr].filter(Boolean).join("\n").trim();
    if (out) errors.push(`\`oxlint --fix\` failed (exit ${lintResult.code}):\n${out}`);
  }

  if (errors.length > 0) return { errors };

  const tcResult = await pi.exec("pnpm", ["--filter", "webm-extension-demo", "run", "typecheck"], {
    timeout: 60_000,
  });
  if (tcResult.code !== 0) {
    const out = [tcResult.stdout, tcResult.stderr].filter(Boolean).join("\n").trim();
    if (out) errors.push(`\`typecheck\` failed (exit ${tcResult.code}):\n${out}`);
  }

  if (errors.length > 0) return { errors };

  const testResult = await pi.exec("pnpm", ["--filter", "webm-extension-demo", "run", "test"], {
    timeout: 120_000,
  });
  if (testResult.code !== 0) {
    const out = [testResult.stdout, testResult.stderr].filter(Boolean).join("\n").trim();
    if (out) errors.push(`\`test\` failed (exit ${testResult.code}):\n${out}`);
  }

  return { errors };
}

// ===========================================================================
// 工具函数
// ===========================================================================

function sendMessage(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(text);
  } else {
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  }
}

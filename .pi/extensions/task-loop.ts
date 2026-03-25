/**
 * task-loop.ts — 核心 Extension：状态驱动的自循环任务系统
 *
 * 这是整个任务系统的"大脑"。它不自己做任何推理工作，
 * 而是根据 task.json 中的当前状态，决定：
 * - 注入什么 prompt 给主 agent（用于需要用户交互或完整工具链的场景）
 * - 派发什么 subagent（用于隔离的、输入输出明确的场景）
 * - 执行什么硬编码检查（lint / typecheck / test）
 *
 * ┌─────────────────── 触发机制 ───────────────────┐
 * │                                                 │
 * │  pi 的 agent_end 事件在每次 LLM 回合结束后触发  │
 * │  ↓                                              │
 * │  读取 task.json → 根据 status 决定下一步        │
 * │  ↓                                              │
 * │  注入 prompt / 派发 subagent / 执行检查          │
 * │  ↓                                              │
 * │  更新 task.json → 等待下一个 agent_end          │
 * │                                                 │
 * └─────────────────────────────────────────────────┘
 *
 * 完整生命周期（对应 task-flow.MD 的设计）：
 *
 * 1. agent-loop.txt 写入目标 → 创建 task.json (brainstorming)
 * 2. 主 agent 与用户头脑风暴 → 写入 .pi/task/spec.md
 * 3. subagent 生成任务计划 → task.json (executing)
 * 4. 对每个任务：
 *    a. pending  → subagent 生成任务 spec
 *    b. preparing → subagent 反思 15min/200k，太大则拆分（递归）
 *    c. ready   → 主 agent 实施任务（含 harness）
 *    d. in_progress → 有文件变更时进入 verifying
 *    e. verifying → 硬编码检查 + LLM 质量反思 → 失败回到 in_progress
 *    f. done    → subagent 生成报告 → 间隙分析 → 下一个任务
 * 5. 所有任务完成 → subagent 最终验收 → 不通过则追加任务继续
 */

import { join } from "node:path";
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
import { loadPrompt, safeReadFile } from "../lib/prompt-loader.js";
import { runSubagent } from "../lib/subagent.js";

// ===========================================================================
// Extension 入口
// ===========================================================================

export default function taskLoop(pi: ExtensionAPI): void {
  /**
   * 追踪当前回合是否有文件变更。
   * 只有 in_progress 状态下有文件变更才会触发 verifying。
   * 这避免了：agent 只是回答问题（没有写文件）就被误判为"完成了任务"。
   */
  let filesModified = false;

  // 监听所有 write/edit 工具调用，标记有文件变更
  pi.on("tool_call", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      filesModified = true;
    }
  });

  /**
   * agent_end 是核心触发点 —— 每次 LLM 回合结束后都会触发。
   *
   * 这个 handler 就是整个状态机的 dispatch：
   * 读取 task.json → 根据 status 路由到对应的 handler。
   */
  pi.on("agent_end", async (_event, ctx) => {
    const piDir = join(ctx.cwd, ".pi");
    const taskFile = await readTaskFile(piDir);

    // task.json 不存在 → 检查 agent-loop.txt 是否有新目标
    if (!taskFile) {
      await handleNoTaskFile(pi, piDir, ctx);
      return;
    }

    // 根据项目级别状态分发
    switch (taskFile.status) {
      case "brainstorming":
        await handleBrainstorming(pi, piDir, taskFile, ctx);
        break;
      case "planning":
        await handlePlanning(pi, piDir, taskFile, ctx);
        break;
      case "executing":
        await handleExecuting(pi, piDir, taskFile, ctx, filesModified);
        filesModified = false; // 重置，下个回合重新计数
        break;
      case "completed":
        // 项目已完成，不做任何事
        break;
    }
  });
}

// ===========================================================================
// 项目级别阶段 handlers
// ===========================================================================

/**
 * 初始触发：检测 agent-loop.txt 是否有目标。
 *
 * 这是整个任务系统的入口点：
 * 1. 用户在 agent-loop.txt 中写入目标文本
 * 2. 本函数检测到后创建 task.json（status: brainstorming）
 * 3. 注入 brainstorm prompt，主 agent 开始与用户交互
 */
async function handleNoTaskFile(
  pi: ExtensionAPI,
  piDir: string,
  ctx: ExtensionContext,
): Promise<void> {
  const goal = (await safeReadFile(join(piDir, "agent-loop.txt"))).trim();
  if (!goal) return; // 没有目标，什么都不做

  // 创建 task.json，进入 brainstorming 阶段
  const taskFile = createTaskFile(goal);
  await writeTaskFile(piDir, taskFile);

  // 加载 brainstorm prompt 模板，注入目标和 spec 存放路径
  const prompt = await loadPrompt(piDir, "brainstorm", {
    goal,
    specPath: join(piDir, "task", "spec.md"),
  });

  // 发送给主 agent（需要与用户交互，所以是主 agent 而非 subagent）
  sendMessage(pi, ctx, prompt);
}

/**
 * 头脑风暴阶段：等待 spec.md 生成，然后进行 spec 审查循环。
 *
 * 这个阶段主 agent 与用户交互，不断细化需求。
 * 每次 agent_end 都会检查 spec.md 是否已存在：
 * - 不存在 → 不做任何事，让用户继续交互
 * - 已存在 → subagent 审查 spec 质量
 *   - 审查通过 → 进入 planning，用 subagent 生成任务计划
 *   - 审查不通过 → 注入问题列表，让主 agent 修复 spec（循环）
 *
 * 借鉴自 superpowers/brainstorming 的 spec 审查循环：
 * 写完 spec 后派发 reviewer subagent 检查完整性、一致性、YAGNI，
 * 确保 spec 质量足够高再进入 planning。
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

  // ---- Spec 审查循环 ----
  // 借鉴 superpowers/brainstorming 的 spec-document-reviewer：
  // 写完 spec 后必须先审查，通过才能进入 planning。
  const reviewPrompt = await loadPrompt(piDir, "review-spec", {
    specContent: spec,
  });
  const reviewResult = await runSubagent(reviewPrompt, ctx.cwd, { tools: ["read"] });
  const review = parseJson(reviewResult.output);

  if (
    review &&
    review.approved === false &&
    Array.isArray(review.issues) &&
    review.issues.length > 0
  ) {
    // spec 审查不通过 → 让主 agent 修复
    const issueList = review.issues
      .map(
        (i: { section: string; issue: string; reason: string }) =>
          `- **${i.section}**: ${i.issue}（${i.reason}）`,
      )
      .join("\n");
    pi.sendUserMessage(`Spec 审查未通过，请修改 \`${specPath}\` 后继续：\n\n${issueList}`, {
      deliverAs: "followUp",
    });
    return; // 保持 brainstorming 状态，下一轮再检查
  }

  // ---- spec 审查通过，进入 planning ----

  const updated: TaskFile = { ...taskFile, status: "planning" };
  await writeTaskFile(piDir, updated);

  // 用 subagent 生成任务计划（隔离上下文，避免污染主对话）
  const context = buildCompletedSummaries(taskFile);
  const planPrompt = await loadPrompt(piDir, "plan", {
    goal: taskFile.goal,
    spec,
    context,
  });

  const result = await runSubagent(planPrompt, ctx.cwd, { tools: ["read", "bash"] });
  const plan = parseJson(result.output);

  if (plan && Array.isArray(plan.tasks) && plan.tasks.length > 0) {
    // 将 subagent 返回的任务列表写入 task.json
    const planned: TaskFile = {
      ...updated,
      status: "executing",
      tasks: plan.tasks.map((t: { title: string }, i: number) => ({
        id: String(i + 1).padStart(3, "0"),
        title: t.title,
        status: "pending" as const,
        summary: null,
      })),
      currentTaskId: "001", // 从第一个任务开始
    };
    await writeTaskFile(piDir, planned);

    pi.sendUserMessage(`任务计划已生成，共 ${planned.tasks.length} 个任务。开始执行第一个任务。`, {
      deliverAs: "followUp",
    });
  } else {
    // subagent 输出格式不对，重试
    pi.sendUserMessage("任务计划生成失败，请重新生成。", { deliverAs: "followUp" });
  }
}

/**
 * Planning 阶段的恢复处理。
 *
 * 正常流程中 handleBrainstorming 会直接跳到 executing。
 * 这个 handler 处理异常情况：如果中断恢复时 status 是 planning
 * 但 tasks 已经有了（说明上次中断在写入 tasks 之后、更新 status 之前），
 * 直接推进到 executing。
 */
async function handlePlanning(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
): Promise<void> {
  if (taskFile.tasks.length > 0) {
    const updated: TaskFile = {
      ...taskFile,
      status: "executing",
      currentTaskId: taskFile.tasks[0].id,
    };
    await writeTaskFile(piDir, updated);
    pi.sendUserMessage("进入执行阶段。", { deliverAs: "followUp" });
  }
}

/**
 * 执行阶段：根据当前任务的状态分发到对应 handler。
 *
 * 这是最复杂的阶段，包含了任务级别的状态机。
 * 每次 agent_end 都会读取 currentTask 并路由。
 */
async function handleExecuting(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
  filesModified: boolean,
): Promise<void> {
  const current = getCurrentTask(taskFile);

  if (!current) {
    // currentTaskId 为 null → 没有 pending 任务了
    if (allTasksDone(taskFile)) {
      await handleFinalValidation(pi, piDir, taskFile, ctx);
    }
    return;
  }

  // 任务级别的状态机 dispatch
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

// ===========================================================================
// 任务级别 handlers
// ===========================================================================

/**
 * pending → preparing：用 subagent 为任务生成详细 spec。
 *
 * 对应设计："开始任务 A 的时候，进入任务A的预备状态，
 * 自动根据 spec 生成这个任务的预期、实施方案"
 *
 * 如果任务是从父任务拆分而来（splitFromId 非空），
 * 会读取父任务的旧 spec 作为额外上下文传给 subagent。
 */
async function handleTaskPending(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  // 更新状态：pending → preparing
  const updated = updateTaskStatus(taskFile, task.id, "preparing");
  await writeTaskFile(piDir, updated);

  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = buildCompletedSummaries(taskFile);
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");

  // 如果是拆分产生的任务，读取父任务的 spec 作为上下文
  // 这实现了设计中的：
  // "生成任务的时候需要拿之前那个过时的 spec 生成任务点和 summary"
  let parentSpec = "";
  if (task.splitFromId) {
    parentSpec = await safeReadFile(join(piDir, "task", task.splitFromId, "spec.md"));
  }

  const prompt = await loadPrompt(piDir, "prepare-task", {
    goal: taskFile.goal,
    projectSpec,
    taskId: task.id,
    taskTitle: task.title,
    completedSummaries,
    taskSpecPath,
    parentSpec,
  });

  // subagent 需要 write 工具来写入 spec 文件
  await runSubagent(prompt, ctx.cwd, { tools: ["read", "write", "bash"] });

  // 下一轮 agent_end 会进入 handleTaskPreparing 做规模反思
  pi.sendUserMessage("任务 spec 已生成，正在评估规模...", { deliverAs: "followUp" });
}

/**
 * preparing：用 subagent 反思任务规模，决定是否拆分。
 *
 * 对应设计："生成完文档之后总是思考：这个任务能不能在 15min 之内完成，
 * 或者能不能在 200k 上下文中完成"
 *
 * 如果反思结果是 feasible=false：
 * - 调用 splitTask() 将当前任务替换为多个子任务
 * - 子任务带 splitFromId，下一轮进入 handleTaskPending 时可以读取旧 spec
 * - 这形成了递归拆分，直到所有任务都足够小
 *
 * 如果 feasible=true：
 * - 更新状态为 ready，下一轮进入 handleTaskReady 开始实施
 */
async function handleTaskPreparing(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");
  const taskSpec = (await safeReadFile(taskSpecPath)).trim();
  if (!taskSpec) return; // spec 文件还没生成完，等下一轮

  // subagent 反思任务规模
  const prompt = await loadPrompt(piDir, "reflect-size", { taskSpec });
  const result = await runSubagent(prompt, ctx.cwd, { tools: ["read"] });
  const reflection = parseJson(result.output);

  if (
    reflection?.feasible === false &&
    Array.isArray(reflection.tasks) &&
    reflection.tasks.length > 0
  ) {
    // ---- 任务太大，拆分 ----
    // splitTask 会：
    // 1. 移除原任务
    // 2. 在原位置插入新的 pending 子任务
    // 3. 新任务带 splitFromId 指向原任务 ID
    // 4. currentTaskId 指向第一个新任务
    const updated = splitTask(taskFile, task.id, reflection.tasks);
    await writeTaskFile(piDir, { ...updated, status: "executing" });
    pi.sendUserMessage(`任务 ${task.id} 过大，已拆分为 ${reflection.tasks.length} 个子任务。`, {
      deliverAs: "followUp",
    });
  } else {
    // ---- 任务可行，进入 ready ----
    const updated = updateTaskStatus(taskFile, task.id, "ready");
    await writeTaskFile(piDir, updated);
    pi.sendUserMessage(
      `任务 ${task.id}（${task.title}）已就绪，开始实施。\n\n请阅读任务 spec：${taskSpecPath}`,
      { deliverAs: "followUp" },
    );
  }
}

/**
 * ready → in_progress：注入实施 prompt 给主 agent。
 *
 * 这是主 agent 真正开始写代码的入口。
 * prompt 中要求：
 * - 按 spec 实施
 * - 通过 lint / typecheck / test
 * - **必须编写 harness**（自验证测试）
 *
 * 为什么是主 agent 而非 subagent？
 * 因为实施任务可能涉及复杂的代码编写、调试、多轮工具调用，
 * 需要完整的上下文和工具链。
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
 * in_progress → verifying：当有文件变更时触发验证流程。
 *
 * 对应设计中的两阶段验证：
 * 1. 硬编码检查（runHardcodedChecks）：lint + typecheck + test
 * 2. LLM 质量反思（handleQualityReflection）：subagent 审查 + 检查 harness
 *
 * 如果任何一步失败，状态回到 in_progress，注入错误信息让主 agent 修复。
 * 这形成了 in_progress ↔ verifying 的循环，直到两个指标都通过。
 *
 * 为什么检查 filesModified？
 * 因为 agent 可能在一轮中只是回答问题而没有写文件，
 * 这种情况下不应该触发验证。
 */
async function handleTaskInProgress(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
  filesModified: boolean,
): Promise<void> {
  if (!filesModified) return; // 没有文件变更，不触发验证

  // 标记为验证中
  const updated = updateTaskStatus(taskFile, task.id, "verifying");
  await writeTaskFile(piDir, updated);

  // ---- 阶段 1：硬编码检查 ----
  const checks = await runHardcodedChecks(pi);
  if (checks.errors.length > 0) {
    // 失败 → 回到 in_progress，让主 agent 修复
    const reverted = updateTaskStatus(updated, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);
    pi.sendUserMessage(`硬编码检查未通过，请修复：\n\n${checks.errors.join("\n\n")}`, {
      deliverAs: "followUp",
    });
    return;
  }

  // ---- 阶段 2：LLM 质量反思 ----
  await handleQualityReflection(pi, piDir, updated, task, ctx);
}

/**
 * verifying 状态的恢复处理。
 *
 * 正常流程中 handleTaskInProgress 会直接处理验证。
 * 如果中断恢复时停在 verifying，说明验证过程被打断，
 * 这里不做操作，等下一轮有文件变更时重新触发。
 */
async function handleTaskVerifying(
  _pi: ExtensionAPI,
  _piDir: string,
  _taskFile: TaskFile,
  _task: Task,
  _ctx: ExtensionContext,
): Promise<void> {
  // 验证由 handleTaskInProgress 驱动。
  // 如果落到这里说明验证已经在进行中，等待下一个触发。
}

/**
 * done 状态的恢复处理：推进到下一个任务。
 *
 * 正常流程中 handleGenerateReport 会调用 advanceToNextTask。
 * 如果中断恢复时停在 done，继续推进。
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
 * 两阶段评审：先 spec 一致性，再代码质量。
 *
 * 借鉴自 superpowers/subagent-driven-development 的核心理念：
 * - 阶段 1（spec compliance）：做了没有？做对没有？有没有多做？harness 在不在？
 * - 阶段 2（code quality）：写得好不好？结构清晰吗？测试质量高吗？
 *
 * **必须先通过 spec compliance 才能进入 code quality。**
 *
 * 任何阶段不通过 → 回到 in_progress，让主 agent 修复（循环）。
 * 两阶段都通过 → 进入报告生成。
 */
async function handleQualityReflection(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const taskSpec = await safeReadFile(join(piDir, "task", task.id, "spec.md"));
  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10_000 });
  const gitDiff = await pi.exec("git", ["diff"], { timeout: 10_000 });

  // ---- 阶段 1：Spec 一致性审查 ----
  // "实现者完成得很快，他们的报告可能不完整、不准确或过于乐观。你必须独立验证一切。"
  const specCompliancePrompt = await loadPrompt(piDir, "review-spec-compliance", {
    taskSpec,
    gitStatus: gitStatus.stdout || "(clean)",
    gitDiff: gitDiff.stdout || "(no changes)",
  });

  const specResult = await runSubagent(specCompliancePrompt, ctx.cwd, { tools: ["read", "bash"] });
  const specReview = parseJson(specResult.output);

  if (specReview && specReview.compliant === false) {
    // spec 一致性不通过 → 回到 in_progress
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

    pi.sendUserMessage(`Spec 一致性审查未通过，请修复后继续：\n\n${issues.join("\n\n")}`, {
      deliverAs: "followUp",
    });
    return;
  }

  // ---- 阶段 2：代码质量审查 ----
  // 只有 spec 一致性通过后才进行代码质量审查
  const codeQualityPrompt = await loadPrompt(piDir, "review-code-quality", {
    taskSpec,
    gitDiff: gitDiff.stdout || "(no changes)",
  });

  const qualityResult = await runSubagent(codeQualityPrompt, ctx.cwd, { tools: ["read", "bash"] });
  const qualityReview = parseJson(qualityResult.output);

  if (qualityReview && qualityReview.approved === false) {
    // 代码质量不通过 → 回到 in_progress
    const reverted = updateTaskStatus(taskFile, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);

    const issueList = (qualityReview.issues || [])
      .filter((i: { severity: string }) => i.severity === "critical" || i.severity === "important")
      .map(
        (i: { severity: string; description: string; file: string }) =>
          `- [${i.severity}] ${i.description}${i.file ? ` (${i.file})` : ""}`,
      )
      .join("\n");

    pi.sendUserMessage(`代码质量审查未通过，请修复后继续：\n\n${issueList}`, {
      deliverAs: "followUp",
    });
    return;
  }

  // 两阶段都通过 → 生成完成报告
  await handleGenerateReport(pi, piDir, taskFile, task, ctx);
}

/**
 * 生成任务完成报告。
 *
 * subagent 读取 git 工作区信息，生成 report.md 并返回 summary。
 *
 * 对应设计：
 * "生成任务 a 的完成报告 summary，以及是否针对能在 15min 中完成，
 * 能不能在 200k 上下文完成"
 *
 * 完成后：
 * 1. 更新任务状态为 done
 * 2. 将 summary 写入 task.json（供后续间隙分析参考）
 * 3. 推进到下一个任务
 * 4. 执行间隙分析
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

  // 收集 git 信息供 subagent 分析
  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10_000 });
  const gitDiff = await pi.exec("git", ["diff"], { timeout: 10_000 });
  const gitLog = await pi.exec("git", ["log", "--oneline", "-10"], { timeout: 10_000 });

  const prompt = await loadPrompt(piDir, "generate-report", {
    taskSpec,
    gitStatus: gitStatus.stdout || "(clean)",
    gitDiff: gitDiff.stdout || "(no changes)",
    gitLog: gitLog.stdout || "(no commits)",
    reportPath,
  });

  const result = await runSubagent(prompt, ctx.cwd, { tools: ["read", "write", "bash"] });
  const report = parseJson(result.output);
  const summary = report?.summary || `任务 ${task.id} 已完成`;

  // 更新状态为 done + 写入 summary + 推进到下一个任务
  let updated = updateTaskStatus(taskFile, task.id, "done");
  updated = updateTaskSummary(updated, task.id, summary);
  updated = advanceToNextTask(updated);
  await writeTaskFile(piDir, updated);

  // 间隙分析：检查是否需要在当前任务和下一个任务之间插入中间任务
  await handleGapAnalysis(pi, piDir, updated, task, ctx);
}

// ===========================================================================
// 间隙分析
// ===========================================================================

/**
 * 任务间隙分析：判断已完成任务和下一个任务之间是否需要插入中间任务。
 *
 * 对应设计：
 * "分析已完成的任务a 和 任务计划的下一个任务 b + spec + a的完成报告summary，
 * 判断要不要在 a b 中增加中间任务（随时反思计划补充任务）"
 *
 * subagent 接收：总目标 + spec + 已完成任务摘要 + 下一任务信息
 * subagent 输出：needsIntermediateTasks + 任务列表
 *
 * 如果需要插入 → insertTasksAfter → 更新 currentTaskId → 继续
 * 如果不需要 → 直接进入下一个任务
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
    // 没有下一个任务 → 所有任务完成，进入最终验收
    if (allTasksDone(taskFile)) {
      await handleFinalValidation(pi, piDir, taskFile, ctx);
    }
    return;
  }

  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = buildCompletedSummaries(taskFile);

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

  const result = await runSubagent(prompt, ctx.cwd, { tools: ["read", "bash"] });
  const gap = parseJson(result.output);

  if (gap?.needsIntermediateTasks && Array.isArray(gap.tasks) && gap.tasks.length > 0) {
    // 需要插入中间任务
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

  // 不需要插入，直接进入下一个任务
  pi.sendUserMessage(
    `任务 ${completedTask.id} 完成。进入下一个任务：${nextTask.id} - ${nextTask.title}`,
    { deliverAs: "followUp" },
  );
}

// ===========================================================================
// 最终验收
// ===========================================================================

/**
 * 最终验收：所有任务完成后，判断是否满足总目标 spec。
 *
 * 对应设计：
 * "直到最后一个任务都完成了，判断是不是符合了任务的 spec，
 * 没有完成就继续深化任务列表"
 *
 * 这是一个闭环：
 * - subagent 判断 passed=true → status 变为 completed，结束
 * - subagent 判断 passed=false + 返回补充任务 → insertTasksAfter → 继续 executing
 * - subagent 判断 passed=false 但没返回任务 → fallback 给主 agent 手动处理
 */
async function handleFinalValidation(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
): Promise<void> {
  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = buildCompletedSummaries(taskFile);
  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10_000 });

  const prompt = await loadPrompt(piDir, "final-validation", {
    goal: taskFile.goal,
    projectSpec,
    completedSummaries,
    gitStatus: gitStatus.stdout || "(clean)",
  });

  const result = await runSubagent(prompt, ctx.cwd, { tools: ["read", "bash"] });
  const validation = parseJson(result.output);

  if (validation?.passed === true) {
    // ---- 验收通过 → 项目完成 ----
    const completed: TaskFile = { ...taskFile, status: "completed" };
    await writeTaskFile(piDir, completed);
    sendMessage(pi, ctx, `## 验收通过 ✅\n\n${validation.reason || "所有任务已满足 spec。"}`);
    return;
  }

  // ---- 验收未通过 → 追加补充任务，继续执行 ----
  if (validation?.tasks && Array.isArray(validation.tasks) && validation.tasks.length > 0) {
    // 找到最后一个 done 的任务，在其后面插入
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
        });
        pi.sendUserMessage(
          `最终验收未通过：${validation.reason || ""}\n已追加 ${validation.tasks.length} 个补充任务，继续执行。`,
          { deliverAs: "followUp" },
        );
        return;
      }
    }
  }

  // Fallback：subagent 未能返回有效的补充任务，交给主 agent
  sendMessage(
    pi,
    ctx,
    `## 最终验收未通过\n\n${validation?.reason || "未能确定原因。"}\n\n请手动补充任务或调整 spec。`,
  );
}

// ===========================================================================
// 硬编码检查
// ===========================================================================

/**
 * 运行硬编码质量检查：fmt → lint → typecheck → test。
 *
 * 对应设计：
 * "（硬编码质量要求）完成任务a后进行 lint，typecheck，测试覆盖率100%"
 *
 * 按顺序执行，遇到错误立即返回（避免后续检查浪费时间）：
 * 1. oxfmt packages     — 格式化
 * 2. oxlint --fix packages — lint + 自动修复
 * 3. typecheck           — TypeScript 类型检查
 * 4. test                — 运行测试（要求 100% 覆盖率）
 *
 * 注意：这里用 npx 直接调用而不是 pnpm run，
 * 因为 pi.exec 执行 pnpm run 在某些环境下会返回错误的退出码。
 */
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

  if (errors.length > 0) return { errors }; // 格式/lint 错误先修，不继续

  const tcResult = await pi.exec("pnpm", ["--filter", "webm-extension-demo", "run", "typecheck"], {
    timeout: 60_000,
  });
  if (tcResult.code !== 0) {
    const out = [tcResult.stdout, tcResult.stderr].filter(Boolean).join("\n").trim();
    if (out) errors.push(`\`typecheck\` failed (exit ${tcResult.code}):\n${out}`);
  }

  if (errors.length > 0) return { errors }; // typecheck 错误先修，不继续

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

/**
 * 智能发送消息：根据 agent 是否空闲选择发送方式。
 *
 * - 空闲时：直接发送，立即触发新回合
 * - 忙碌时：用 followUp 排队，等当前回合结束后再送达
 *
 * pi 的消息投递模式：
 * - sendUserMessage(text)                → 立即发送（agent 必须空闲）
 * - sendUserMessage(text, {deliverAs: 'steer'})   → 当前 turn 后投递
 * - sendUserMessage(text, {deliverAs: 'followUp'}) → agent 完全空闲后投递
 */
function sendMessage(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(text);
  } else {
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  }
}

/**
 * 健壮的 JSON 解析：尝试多种方式从 LLM 输出中提取 JSON。
 *
 * LLM 经常不严格遵守"只输出 JSON"的指令，可能会：
 * 1. 直接输出纯 JSON（最理想）
 * 2. 包裹在 ```json ... ``` 代码块中
 * 3. 在 JSON 前后加了解释文本
 *
 * 本函数按优先级尝试：
 * 1. 直接 JSON.parse
 * 2. 从 markdown 代码块中提取
 * 3. 找到第一个 { 到最后一个 } 的范围
 */
function parseJson(text: string): any {
  // 尝试 1：直接解析
  try {
    return JSON.parse(text.trim());
  } catch {
    // 尝试 2：从 markdown 代码块提取
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        /* fall through */
      }
    }
    // 尝试 3：找 { ... } 范围
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

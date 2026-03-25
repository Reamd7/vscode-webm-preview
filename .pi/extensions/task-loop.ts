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

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function taskLoop(pi: ExtensionAPI): void {
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
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

async function handleNoTaskFile(
  pi: ExtensionAPI,
  piDir: string,
  ctx: ExtensionContext,
): Promise<void> {
  const goal = (await safeReadFile(join(piDir, "agent-loop.txt"))).trim();
  if (!goal) return;

  const taskFile = createTaskFile(goal);
  await writeTaskFile(piDir, taskFile);

  const prompt = await loadPrompt(piDir, "brainstorm", {
    goal,
    specPath: join(piDir, "task", "spec.md"),
  });

  sendMessage(pi, ctx, prompt);
}

async function handleBrainstorming(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
): Promise<void> {
  const spec = (await safeReadFile(join(piDir, "task", "spec.md"))).trim();
  if (!spec) return; // spec not ready yet, let user keep interacting

  // spec written → move to planning
  const updated: TaskFile = { ...taskFile, status: "planning" };
  await writeTaskFile(piDir, updated);

  const context = buildCompletedSummaries(taskFile);
  const planPrompt = await loadPrompt(piDir, "plan", {
    goal: taskFile.goal,
    spec,
    context,
  });

  const result = await runSubagent(planPrompt, ctx.cwd, { tools: ["read", "bash"] });
  const plan = parseJson(result.output);

  if (plan && Array.isArray(plan.tasks) && plan.tasks.length > 0) {
    const planned: TaskFile = {
      ...updated,
      status: "executing",
      tasks: plan.tasks.map((t: { title: string }, i: number) => ({
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
  } else {
    pi.sendUserMessage("任务计划生成失败，请重新生成。", { deliverAs: "followUp" });
  }
}

async function handlePlanning(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
): Promise<void> {
  // If we're still in planning but tasks already exist, advance to executing
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

async function handleExecuting(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
  filesModified: boolean,
): Promise<void> {
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

// ---------------------------------------------------------------------------
// Task-level handlers
// ---------------------------------------------------------------------------

async function handleTaskPending(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const updated = updateTaskStatus(taskFile, task.id, "preparing");
  await writeTaskFile(piDir, updated);

  const projectSpec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = buildCompletedSummaries(taskFile);
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");

  const prompt = await loadPrompt(piDir, "prepare-task", {
    goal: taskFile.goal,
    projectSpec,
    taskId: task.id,
    taskTitle: task.title,
    completedSummaries,
    taskSpecPath,
  });

  await runSubagent(prompt, ctx.cwd, { tools: ["read", "write", "bash"] });

  // Next agent_end will pick up 'preparing' and do size reflection
  pi.sendUserMessage("任务 spec 已生成，正在评估规模...", { deliverAs: "followUp" });
}

async function handleTaskPreparing(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const taskSpecPath = join(piDir, "task", task.id, "spec.md");
  const taskSpec = (await safeReadFile(taskSpecPath)).trim();
  if (!taskSpec) return; // spec not ready yet

  const prompt = await loadPrompt(piDir, "reflect-size", { taskSpec });
  const result = await runSubagent(prompt, ctx.cwd, { tools: ["read"] });
  const reflection = parseJson(result.output);

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
    "## 要求",
    "- 代码需要通过 lint, typecheck, 测试",
    "- 测试覆盖率 100%",
    "- 完成后告知我",
  ].join("\n");

  sendMessage(pi, ctx, prompt);
}

async function handleTaskInProgress(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
  filesModified: boolean,
): Promise<void> {
  if (!filesModified) return;

  const updated = updateTaskStatus(taskFile, task.id, "verifying");
  await writeTaskFile(piDir, updated);

  const checks = await runHardcodedChecks(pi);
  if (checks.errors.length > 0) {
    const reverted = updateTaskStatus(updated, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);
    pi.sendUserMessage(`硬编码检查未通过，请修复：\n\n${checks.errors.join("\n\n")}`, {
      deliverAs: "followUp",
    });
    return;
  }

  await handleQualityReflection(pi, piDir, updated, task, ctx);
}

async function handleTaskVerifying(
  _pi: ExtensionAPI,
  _piDir: string,
  _taskFile: TaskFile,
  _task: Task,
  _ctx: ExtensionContext,
): Promise<void> {
  // Verification is driven by handleTaskInProgress.
  // If we land here it means verification is already in progress.
}

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

// ---------------------------------------------------------------------------
// Quality & Report
// ---------------------------------------------------------------------------

async function handleQualityReflection(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  task: Task,
  ctx: ExtensionContext,
): Promise<void> {
  const taskSpec = await safeReadFile(join(piDir, "task", task.id, "spec.md"));
  const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 10_000 });
  const gitDiff = await pi.exec("git", ["diff", "--stat"], { timeout: 10_000 });

  const prompt = await loadPrompt(piDir, "verify-quality", {
    taskSpec,
    gitStatus: gitStatus.stdout || "(clean)",
    gitDiff: gitDiff.stdout || "(no changes)",
  });

  const result = await runSubagent(prompt, ctx.cwd, { tools: ["read", "bash"] });
  const quality = parseJson(result.output);

  if (quality?.passed === false) {
    const reverted = updateTaskStatus(taskFile, task.id, "in_progress");
    await writeTaskFile(piDir, reverted);
    const issues = (quality.issues || []).join("\n- ");
    pi.sendUserMessage(`任务质量检查未通过：\n- ${issues}\n\n请修复后继续。`, {
      deliverAs: "followUp",
    });
    return;
  }

  await handleGenerateReport(pi, piDir, taskFile, task, ctx);
}

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

  let updated = updateTaskStatus(taskFile, task.id, "done");
  updated = updateTaskSummary(updated, task.id, summary);
  updated = advanceToNextTask(updated);
  await writeTaskFile(piDir, updated);

  await handleGapAnalysis(pi, piDir, updated, task, ctx);
}

// ---------------------------------------------------------------------------
// Gap analysis
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Final validation
// ---------------------------------------------------------------------------

async function handleFinalValidation(
  pi: ExtensionAPI,
  piDir: string,
  taskFile: TaskFile,
  ctx: ExtensionContext,
): Promise<void> {
  const spec = await safeReadFile(join(piDir, "task", "spec.md"));
  const completedSummaries = buildCompletedSummaries(taskFile);

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

  sendMessage(pi, ctx, prompt);
}

// ---------------------------------------------------------------------------
// Hardcoded checks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sendMessage(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(text);
  } else {
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  }
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text.trim());
  } catch {
    // try extracting from markdown code block
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        /* fall through */
      }
    }
    // try finding first { ... last }
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

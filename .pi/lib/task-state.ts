/**
 * task-state.ts — task.json 的读写和纯状态操作函数
 *
 * 核心职责：
 * 1. 定义整个任务系统的类型（ProjectStatus, TaskStatus, Task, TaskFile）
 * 2. 读写 task.json 文件（持久化状态）
 * 3. 提供不可变的纯函数来操作任务状态（不直接 IO，返回新对象）
 *
 * 设计原则：
 * - 所有状态操作都是纯函数，接收旧 TaskFile 返回新 TaskFile
 * - IO 操作（readTaskFile / writeTaskFile）和状态操作分离
 * - 任务 ID 用 3 位数字字符串 "001", "002" ...，方便排序和显示
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";

// --- Types ---

/**
 * 项目级别的状态，对应整个任务系统的生命周期阶段。
 *
 * brainstorming → reviewing_spec → planning → executing → validating → completed
 *
 * - brainstorming:  主 agent 与用户交互，细化需求，生成 spec.md
 * - reviewing_spec: subagent 正在审查 spec（防止重入）
 * - planning:       subagent 根据 spec 生成任务列表写入 task.json
 * - executing:      逐个执行任务（大部分时间都在这个阶段）
 * - validating:     subagent 正在做最终验收（防止重入）
 * - completed:      所有任务完成且通过最终验收
 */
export type ProjectStatus =
  | "brainstorming"
  | "reviewing_spec"
  | "planning"
  | "executing"
  | "validating"
  | "completed";

/**
 * 单个任务的状态，对应每个任务的生命周期阶段。
 *
 * pending → preparing → reflecting → ready → in_progress → verifying → done
 *               |                                  ↑             |
 *               |                                  └── failed ───┘
 *               └── split (回到 pending 的子任务)
 *
 * - pending:     只有标题，还没有展开（避免信息过载）
 * - preparing:   subagent 正在生成任务 spec
 * - reflecting:  subagent 正在反思任务规模（15min/200k），决定是否拆分
 * - ready:       spec 已确认可在 15min/200k 内完成，等待实施
 * - in_progress: 主 agent 正在实施任务
 * - verifying:   硬编码检查 + LLM 质量反思
 * - done:        通过验证，完成报告已生成
 */
export type TaskStatus =
  | "pending"
  | "preparing"
  | "reflecting"
  | "ready"
  | "in_progress"
  | "verifying"
  | "done";

/**
 * 单个任务的数据结构。
 *
 * 关键设计：
 * - pending 阶段只有 title，spec 文件在 preparing 阶段才由 subagent 生成
 * - done 阶段有 summary，供后续任务和间隙分析参考（避免读取完整报告）
 * - splitFromId 记录拆分来源，子任务生成 spec 时可以读取父任务的旧 spec 作为上下文
 */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  summary: string | null;
  /** ID of the task this was split from (for inheriting parent spec context). */
  splitFromId?: string;
  /** spec 生成连续失败次数（防止无限重试）。 */
  prepareAttempts?: number;
}

/**
 * task.json 的完整结构。
 *
 * - goal:                用户的原始目标文本（从 agent-loop.txt 读取）
 * - status:              项目级别状态
 * - currentTaskId:       当前正在处理的任务 ID（串行执行，永远只有一个）
 * - tasks:               扁平任务列表，按执行顺序排列
 * - validationAttempts:  最终验收的连续尝试次数（用于防止无限验收循环）
 */
export interface TaskFile {
  goal: string;
  status: ProjectStatus;
  currentTaskId: string | null;
  tasks: Task[];
  validationAttempts?: number;
  /** spec 审查不通过时记录的 spec 内容哈希，防止对同一份 spec 重复审查。 */
  _lastReviewedSpecHash?: string;
}

// --- Read / Write ---

const TASK_FILE = "task.json";

/**
 * 读取 .pi/task.json，不存在或解析失败返回 null。
 * extension 通过返回值判断任务系统是否已激活。
 */
export async function readTaskFile(piDir: string): Promise<TaskFile | null> {
  let content: string;
  try {
    content = await readFile(join(piDir, TASK_FILE), "utf8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  try {
    return JSON.parse(content) as TaskFile;
  } catch {
    console.warn(`[task-state] Failed to parse ${join(piDir, TASK_FILE)}, returning null`);
    return null;
  }
}

/**
 * 写入 .pi/task.json，自动创建目录。
 * 这是任务系统的唯一持久化入口，支持中断恢复。
 */
export async function writeTaskFile(piDir: string, taskFile: TaskFile): Promise<void> {
  const filePath = join(piDir, TASK_FILE);
  const tmpPath = filePath + ".tmp";
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, JSON.stringify(taskFile, null, 2), "utf8");
  await rename(tmpPath, filePath);
}

// --- Pure state operations ---

/** 创建初始 TaskFile，状态为 brainstorming，无任务。 */
export function createTaskFile(goal: string): TaskFile {
  return { goal, status: "brainstorming", currentTaskId: null, tasks: [] };
}

/** 根据 currentTaskId 获取当前任务对象。 */
export function getCurrentTask(taskFile: TaskFile): Task | null {
  if (!taskFile.currentTaskId) return null;
  return taskFile.tasks.find((t) => t.id === taskFile.currentTaskId) ?? null;
}

/** 不可变地更新指定任务的状态。 */
export function updateTaskStatus(taskFile: TaskFile, taskId: string, status: TaskStatus): TaskFile {
  return {
    ...taskFile,
    tasks: taskFile.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
  };
}

/** 不可变地更新指定任务的完成摘要。 */
export function updateTaskSummary(taskFile: TaskFile, taskId: string, summary: string): TaskFile {
  return {
    ...taskFile,
    tasks: taskFile.tasks.map((t) => (t.id === taskId ? { ...t, summary } : t)),
  };
}

/**
 * 拆分任务：将 targetId 替换为多个新 pending 任务。
 *
 * 关键行为：
 * - 新任务插入到 targetId 所在位置，保持串行顺序
 * - 旧任务被移除，新任务记录 splitFromId 指向旧任务 ID
 * - currentTaskId 自动指向第一个新任务
 * - 旧任务的 spec 文件保留在磁盘上（.pi/task/{targetId}/spec.md），
 *   新任务在 preparing 阶段可以通过 splitFromId 读取作为上下文
 *
 * 这实现了设计中的递归拆分：如果子任务仍然太大，下一轮 preparing
 * 会再次触发 splitTask，直到所有任务都足够小。
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

  let num = Math.max(...taskFile.tasks.map((t) => parseInt(t.id, 10)), 0);
  const created: Task[] = newTasks.map((nt) => {
    num++;
    return {
      id: String(num).padStart(3, "0"),
      title: nt.title,
      status: "pending" as TaskStatus,
      summary: null,
      splitFromId: targetId,
    };
  });

  const tasks = [...before, ...created, ...after];
  return {
    ...taskFile,
    tasks,
    currentTaskId: created[0]?.id ?? taskFile.currentTaskId,
  };
}

/**
 * 在指定任务后插入新的 pending 任务。
 *
 * 用于两个场景：
 * 1. 间隙分析（gap analysis）：在已完成任务和下一个任务之间插入中间任务
 * 2. 最终验收失败：在所有已完成任务后追加补充任务
 */
export function insertTasksAfter(
  taskFile: TaskFile,
  afterId: string,
  newTasks: Array<{ title: string }>,
): TaskFile {
  const index = taskFile.tasks.findIndex((t) => t.id === afterId);
  if (index === -1) return taskFile;

  let num = Math.max(...taskFile.tasks.map((t) => parseInt(t.id, 10)), 0);
  const created: Task[] = newTasks.map((nt) => {
    num++;
    return {
      id: String(num).padStart(3, "0"),
      title: nt.title,
      status: "pending" as TaskStatus,
      summary: null,
    };
  });

  const tasks = [
    ...taskFile.tasks.slice(0, index + 1),
    ...created,
    ...taskFile.tasks.slice(index + 1),
  ];

  return { ...taskFile, tasks };
}

/**
 * 将 currentTaskId 推进到下一个 pending 任务。
 * 如果没有 pending 任务了，设为 null（触发最终验收）。
 */
export function advanceToNextTask(taskFile: TaskFile): TaskFile {
  const next = taskFile.tasks.find((t) => t.status === "pending");
  return { ...taskFile, currentTaskId: next?.id ?? null };
}

/** 检查是否所有任务都已完成。 */
export function allTasksDone(taskFile: TaskFile): boolean {
  return taskFile.tasks.length > 0 && taskFile.tasks.every((t) => t.status === "done");
}

/**
 * 构建已完成任务的摘要文本。
 * 用于注入 prompt，让 subagent/主 agent 了解之前完成了什么，
 * 避免读取完整报告导致上下文膨胀。
 */
export function buildCompletedSummaries(taskFile: TaskFile): string {
  const done = taskFile.tasks.filter((t) => t.status === "done");
  if (done.length === 0) return "(暂无已完成任务)";
  return done.map((t) => `- [${t.id}] ${t.title}: ${t.summary || "(无摘要)"}`).join("\n");
}

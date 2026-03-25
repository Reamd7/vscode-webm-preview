import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// --- Types ---

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

// --- Read / Write ---

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

// --- Pure state operations ---

export function createTaskFile(goal: string): TaskFile {
  return { goal, status: "brainstorming", currentTaskId: null, tasks: [] };
}

export function getCurrentTask(taskFile: TaskFile): Task | null {
  if (!taskFile.currentTaskId) return null;
  return taskFile.tasks.find((t) => t.id === taskFile.currentTaskId) ?? null;
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

function nextId(tasks: Task[]): string {
  const max = tasks.reduce((m, t) => Math.max(m, parseInt(t.id, 10)), 0);
  return String(max + 1).padStart(3, "0");
}

/**
 * Replace targetId with new pending tasks at the same position.
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
 * Insert new pending tasks after afterId.
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
 * Advance currentTaskId to the next pending task.
 */
export function advanceToNextTask(taskFile: TaskFile): TaskFile {
  const next = taskFile.tasks.find((t) => t.status === "pending");
  return { ...taskFile, currentTaskId: next?.id ?? null };
}

export function allTasksDone(taskFile: TaskFile): boolean {
  return taskFile.tasks.length > 0 && taskFile.tasks.every((t) => t.status === "done");
}

export function buildCompletedSummaries(taskFile: TaskFile): string {
  const done = taskFile.tasks.filter((t) => t.status === "done");
  if (done.length === 0) return "(暂无已完成任务)";
  return done.map((t) => `- [${t.id}] ${t.title}: ${t.summary || "(无摘要)"}`).join("\n");
}

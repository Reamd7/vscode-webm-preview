/**
 * prepare-task agent — 为 pending 任务生成 spec 文件
 *
 * Side-effect agent：写入 taskSpecPath 文件，不返回结构化数据。
 *
 * 输入：goal, projectSpec, taskId, taskTitle, completedSummaries, taskSpecPath, parentSpec
 */

import { loadAgentPrompt, runSubagent, type SubagentEvent } from "../_utils.js";

export async function prepareTask(
  params: {
    goal: string;
    projectSpec: string;
    taskId: string;
    taskTitle: string;
    completedSummaries: string;
    taskSpecPath: string;
    parentSpec: string;
  },
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<void> {
  const prompt = await loadAgentPrompt(import.meta.url, params);
  await runSubagent(prompt, cwd, {
    tools: ["read", "write", "bash"],
    onEvent,
  });
}

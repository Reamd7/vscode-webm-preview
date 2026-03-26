/**
 * reflect-size agent — 评估任务规模是否可行（15min / 200k context）
 *
 * 输入：taskSpec
 * 输出：{ feasible, reason, tasks? }
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface FeasibilityResult {
  feasible: boolean;
  reason: string;
  tasks?: Array<{ title: string }>;
}

export async function reflectSize(
  taskSpec: string,
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<FeasibilityResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, { taskSpec });
  const result = await runSubagent(prompt, cwd, {
    tools: ["read"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<FeasibilityResult>(result);
}

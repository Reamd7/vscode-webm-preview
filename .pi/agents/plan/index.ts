/**
 * plan agent — 根据 spec 生成串行任务计划
 *
 * 输入：goal, spec, context (已完成任务摘要)
 * 输出：{ tasks: [{ title, files, verify }] }
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface PlanTask {
  title: string;
  files: string[];
  verify: string;
}

export interface PlanResult {
  tasks: PlanTask[];
}

export async function generatePlan(
  goal: string,
  spec: string,
  context: string,
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<PlanResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, { goal, spec, context });
  const result = await runSubagent(prompt, cwd, {
    tools: ["read", "bash"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<PlanResult>(result);
}

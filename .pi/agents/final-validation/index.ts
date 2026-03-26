/**
 * final-validation agent — 最终项目验收
 *
 * 输入：goal, projectSpec, completedSummaries, gitStatus
 * 输出：{ passed, reason, tasks? }
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface ValidationResult {
  passed: boolean;
  reason: string;
  tasks?: Array<{ title: string }>;
}

export async function validateProject(
  goal: string,
  projectSpec: string,
  completedSummaries: string,
  gitStatus: string,
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<ValidationResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, {
    goal,
    projectSpec,
    completedSummaries,
    gitStatus,
  });
  const result = await runSubagent(prompt, cwd, {
    tools: ["read", "bash"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<ValidationResult>(result);
}

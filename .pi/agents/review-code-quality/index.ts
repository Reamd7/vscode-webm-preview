/**
 * review-code-quality agent — 审查代码质量
 *
 * 输入：taskSpec, gitDiff
 * 输出：{ approved, strengths, issues }
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface CodeQualityIssue {
  severity: "critical" | "important" | "minor";
  description: string;
  file: string;
}

export interface CodeQualityResult {
  approved: boolean;
  strengths: string[];
  issues: CodeQualityIssue[];
}

export async function reviewCodeQuality(
  taskSpec: string,
  gitDiff: string,
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<CodeQualityResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, { taskSpec, gitDiff });
  const result = await runSubagent(prompt, cwd, {
    tools: ["read", "bash"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<CodeQualityResult>(result);
}

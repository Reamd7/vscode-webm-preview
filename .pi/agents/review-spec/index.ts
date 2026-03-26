/**
 * review-spec agent — 审查 spec 文档质量
 *
 * 输入：spec 内容
 * 输出：{ approved, issues?, recommendations? }
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface ReviewResult {
  approved: boolean;
  issues?: Array<{ section: string; issue: string; reason: string }>;
  recommendations?: string[];
}

export async function reviewSpec(
  specContent: string,
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<ReviewResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, { specContent });
  const result = await runSubagent(prompt, cwd, {
    tools: ["read"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<ReviewResult>(result);
}

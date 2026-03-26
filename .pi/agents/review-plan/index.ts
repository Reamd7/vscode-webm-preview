/**
 * review-plan agent — 审查任务计划质量
 *
 * 输入：goal, spec, planJson
 * 输出：{ approved, issues?, recommendations? }
 *
 * 复用 submit_review tool（和 review-spec 相同的 schema）。
 * issues 里的 section 字段在此场景下表示 "任务N"。
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface PlanReviewResult {
  approved: boolean;
  issues?: Array<{ section: string; issue: string; reason: string }>;
  recommendations?: string[];
}

export async function reviewPlan(
  goal: string,
  spec: string,
  planJson: string,
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<PlanReviewResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, { goal, spec, planJson });
  const result = await runSubagent(prompt, cwd, {
    tools: ["read"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<PlanReviewResult>(result);
}

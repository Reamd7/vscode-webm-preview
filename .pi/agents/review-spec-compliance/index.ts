/**
 * review-spec-compliance agent — 审查实现是否符合 spec
 *
 * 输入：taskSpec, gitStatus, gitDiff
 * 输出：{ compliant, missing, extra, misunderstandings, harnessExists }
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface SpecComplianceResult {
  compliant: boolean;
  missing: string[];
  extra: string[];
  misunderstandings: string[];
  harnessExists: boolean;
}

export async function reviewSpecCompliance(
  taskSpec: string,
  gitStatus: string,
  gitDiff: string,
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<SpecComplianceResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, { taskSpec, gitStatus, gitDiff });
  const result = await runSubagent(prompt, cwd, {
    tools: ["read", "bash"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<SpecComplianceResult>(result);
}

/**
 * gap-analysis agent — 分析已完成任务和下一任务之间是否需要中间任务
 *
 * 输入：goal, projectSpec, completedTaskId/Title/Summary, nextTaskId/Title, completedSummaries
 * 输出：{ needsIntermediateTasks, reason, tasks? }
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface GapAnalysisResult {
  needsIntermediateTasks: boolean;
  reason: string;
  tasks?: Array<{ title: string }>;
}

export async function analyzeGap(
  params: {
    goal: string;
    projectSpec: string;
    completedTaskId: string;
    completedTaskTitle: string;
    completedTaskSummary: string;
    nextTaskId: string;
    nextTaskTitle: string;
    completedSummaries: string;
  },
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<GapAnalysisResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, params);
  const result = await runSubagent(prompt, cwd, {
    tools: ["read", "bash"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<GapAnalysisResult>(result);
}

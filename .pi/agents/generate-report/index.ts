/**
 * generate-report agent — 生成任务完成报告
 *
 * 混合模式：先写报告文件（side-effect），再通过 tool_use 返回摘要。
 *
 * 输入：taskSpec, gitStatus, gitDiff, gitLog, reportPath
 * 输出：{ summary, withinTimeEstimate, withinContextEstimate, retrospective }
 */

import {
  loadAgentPrompt,
  getToolExtensionPath,
  extractResult,
  runSubagent,
  type SubagentEvent,
} from "../_utils.js";

export interface ReportResult {
  summary: string;
  withinTimeEstimate: boolean;
  withinContextEstimate: boolean;
  retrospective: string;
}

export async function generateReport(
  taskSpec: string,
  gitStatus: string,
  gitDiff: string,
  gitLog: string,
  reportPath: string,
  cwd: string,
  onEvent?: (event: SubagentEvent) => void,
): Promise<ReportResult | null> {
  const prompt = await loadAgentPrompt(import.meta.url, {
    taskSpec,
    gitStatus,
    gitDiff,
    gitLog,
    reportPath,
  });
  const result = await runSubagent(prompt, cwd, {
    tools: ["read", "write", "bash"],
    extensions: [getToolExtensionPath(import.meta.url)],
    onEvent,
  });
  return extractResult<ReportResult>(result);
}

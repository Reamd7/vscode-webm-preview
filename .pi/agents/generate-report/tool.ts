/**
 * submit-report — generate-report 的结构化输出 tool
 *
 * 注意：generate-report 是混合模式（先写报告文件，再返回 JSON 摘要）。
 * subagent 先用 write tool 写文件，然后调用此 tool 返回摘要。
 *
 * 校验机制：
 * 1. tool execute 层：Value.Check 校验，不通过返回 isError（同 turn 即时反馈）
 * 2. agent_end 层：最终校验，未调用 tool 或校验不通过 → sendUserMessage 继续对话
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const schema = Type.Object({
  summary: Type.String({ description: "Short summary, max 100 chars" }),
  withinTimeEstimate: Type.Boolean({ description: "Whether completed within time estimate" }),
  withinContextEstimate: Type.Boolean({
    description: "Whether completed within context estimate",
  }),
  retrospective: Type.String({
    description: "Explanation if estimates were exceeded, or empty string",
  }),
});

export default function (pi: ExtensionAPI): void {
  let lastParams: unknown = null;
  let validated = false;

  pi.registerTool({
    name: "submit_report",
    label: "Submit Report",
    description:
      "Submit the task completion report summary. You MUST call this tool after writing the report file.",
    parameters: schema,
    async execute(_toolCallId, params) {
      lastParams = params;
      if (!Value.Check(schema, params)) {
        validated = false;
        const errors = [...Value.Errors(schema, params)]
          .map((e) => `${e.path}: ${e.message}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Schema validation failed. Fix these errors and call this tool again:\n${errors}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
      validated = true;
      return {
        content: [{ type: "text", text: JSON.stringify(params) }],
        details: {},
      };
    },
  });

  pi.on("agent_end", () => {
    if (validated) return;

    if (lastParams == null) {
      pi.sendUserMessage(
        "You did not call the submit_report tool. You MUST call submit_report to return your result. Do it now.",
        { deliverAs: "followUp" },
      );
      return;
    }

    const errors = [...Value.Errors(schema, lastParams)]
      .map((e) => `${e.path}: ${e.message}`)
      .join("\n");
    pi.sendUserMessage(
      `Your last submit_report call failed schema validation:\n${errors}\n\nFix these errors and call submit_report again.`,
      { deliverAs: "followUp" },
    );
  });
}

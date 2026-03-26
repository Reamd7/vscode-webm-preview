/**
 * submit-review — review-spec 的结构化输出 tool
 *
 * 校验机制：
 * 1. tool execute 层：Value.Check 校验，不通过返回 isError（同 turn 即时反馈）
 * 2. agent_end 层：最终校验，未调用 tool 或校验不通过 → sendUserMessage 继续对话
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const schema = Type.Object({
  approved: Type.Boolean({ description: "Whether the review passes" }),
  issues: Type.Optional(
    Type.Array(
      Type.Object({
        section: Type.String({ description: "Section name or task index" }),
        issue: Type.String({ description: "Specific problem found" }),
        reason: Type.String({ description: "Why it matters or suggestion to fix" }),
      }),
    ),
  ),
  recommendations: Type.Optional(
    Type.Array(Type.String({ description: "Optional improvement suggestion" })),
  ),
});

export default function (pi: ExtensionAPI): void {
  let lastParams: unknown = null;
  let validated = false;

  pi.registerTool({
    name: "submit_review",
    label: "Submit Review",
    description: "Submit your review result. You MUST call this tool to return your review.",
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
        "You did not call the submit_review tool. You MUST call submit_review to return your result. Do it now.",
        { deliverAs: "followUp" },
      );
      return;
    }

    const errors = [...Value.Errors(schema, lastParams)]
      .map((e) => `${e.path}: ${e.message}`)
      .join("\n");
    pi.sendUserMessage(
      `Your last submit_review call failed schema validation:\n${errors}\n\nFix these errors and call submit_review again.`,
      { deliverAs: "followUp" },
    );
  });
}

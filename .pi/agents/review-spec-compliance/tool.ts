/**
 * submit-spec-compliance — review-spec-compliance 的结构化输出 tool
 *
 * 校验机制：
 * 1. tool execute 层：Value.Check 校验，不通过返回 isError（同 turn 即时反馈）
 * 2. agent_end 层：最终校验，未调用 tool 或校验不通过 → sendUserMessage 继续对话
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const schema = Type.Object({
  compliant: Type.Boolean({ description: "Whether the implementation complies with the spec" }),
  missing: Type.Array(Type.String({ description: "Missing requirement" })),
  extra: Type.Array(Type.String({ description: "Extra/unrequested implementation" })),
  misunderstandings: Type.Array(Type.String({ description: "Misinterpretation of spec" })),
  harnessExists: Type.Boolean({ description: "Whether self-verifying harness tests exist" }),
});

export default function (pi: ExtensionAPI): void {
  let lastParams: unknown = null;
  let validated = false;

  pi.registerTool({
    name: "submit_spec_compliance",
    label: "Submit Spec Compliance",
    description:
      "Submit your spec compliance review result. You MUST call this tool to return your review.",
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
        "You did not call the submit_spec_compliance tool. You MUST call submit_spec_compliance to return your result. Do it now.",
        { deliverAs: "followUp" },
      );
      return;
    }

    const errors = [...Value.Errors(schema, lastParams)]
      .map((e) => `${e.path}: ${e.message}`)
      .join("\n");
    pi.sendUserMessage(
      `Your last submit_spec_compliance call failed schema validation:\n${errors}\n\nFix these errors and call submit_spec_compliance again.`,
      { deliverAs: "followUp" },
    );
  });
}

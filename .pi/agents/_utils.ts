/**
 * _utils.ts — agent 模块共享的工具函数
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSubagent, type SubagentResult, type SubagentEvent } from "../lib/subagent.js";

/**
 * 加载同目录下的 prompt.md 并替换 {{variable}} 占位符。
 *
 * @param importMetaUrl - 调用方的 import.meta.url（用于定位 prompt.md）
 * @param variables     - 键值对，key 对应模板中的 {{key}}
 */
export async function loadAgentPrompt(
  importMetaUrl: string,
  variables: Record<string, string> = {},
): Promise<string> {
  const dir = dirname(fileURLToPath(importMetaUrl));
  const filePath = join(dir, "prompt.md");
  let content = await readFile(filePath, "utf8");
  for (const [key, value] of Object.entries(variables)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content.trim();
}

/**
 * 获取同目录下的 tool.ts 绝对路径（用于 -e 传给 subagent）。
 */
export function getToolExtensionPath(importMetaUrl: string): string {
  const dir = dirname(fileURLToPath(importMetaUrl));
  return join(dir, "tool.ts");
}

/**
 * 从 SubagentResult 中提取结构化结果。
 * 优先使用 toolResult（通过 tool_use 返回），fallback 到解析 output 文本。
 */
export function extractResult<T>(result: SubagentResult): T | null {
  if (result.toolResult) return result.toolResult as T;
  return parseJson(result.output) as T | null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        /* fall through */
      }
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

export { runSubagent, type SubagentEvent };

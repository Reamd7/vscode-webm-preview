/**
 * prompt-loader.ts — Prompt 模板加载和变量替换
 *
 * 职责：
 * - 从 .pi/prompts/ 加载 .md 模板文件
 * - 将模板中的 {{variable}} 占位符替换为实际值
 * - 提供安全的文件读取工具函数
 *
 * 模板示例（.pi/prompts/brainstorm.md）：
 *   ## 目标
 *   {{goal}}
 *   ## 生成 spec
 *   将 spec 写入 {{specPath}}
 *
 * 调用方式：
 *   const prompt = await loadPrompt(piDir, 'brainstorm', { goal: '...', specPath: '...' });
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 加载 prompt 模板并替换 {{variable}} 占位符。
 *
 * @param piDir        - .pi 目录的绝对路径
 * @param templateName - 模板名称（不含 .md 后缀），对应 .pi/prompts/{templateName}.md
 * @param variables    - 键值对，key 对应模板中的 {{key}}
 * @returns 替换后的 prompt 文本
 */
export async function loadPrompt(
  piDir: string,
  templateName: string,
  variables: Record<string, string> = {},
): Promise<string> {
  const filePath = join(piDir, "prompts", `${templateName}.md`);
  let content = await readFile(filePath, "utf8");

  for (const [key, value] of Object.entries(variables)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  return content.trim();
}

/**
 * 安全地读取文件内容，文件不存在时返回空字符串。
 * 在任务系统中大量使用，因为很多文件（spec.md, report.md）可能还未生成。
 */
export async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

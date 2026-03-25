import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Load a prompt template from .pi/prompts/ and replace {{variable}} placeholders.
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
 * Read a file, return empty string if it doesn't exist.
 */
export async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

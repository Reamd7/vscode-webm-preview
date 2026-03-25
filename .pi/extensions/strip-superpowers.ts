/**
 * strip-superpowers.ts — 从 provider 请求中移除 superpowers skills
 *
 * 在发送给 LLM 之前，拦截 before_provider_request 事件，
 * 从 system/developer 消息的 <available_skills> 块中移除所有
 * 路径包含 /.agents/skills/superpowers/ 的 skill 条目。
 *
 * 这避免了 superpowers skill 指令干扰任务系统的自动化流程。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stripSuperpowersSkillsFromPayload } from "../lib/strip-superpowers.js";

export default function stripSuperpowersSkillsExtension(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => {
    const filtered = stripSuperpowersSkillsFromPayload(event.payload);
    return filtered.payload;
  });
}

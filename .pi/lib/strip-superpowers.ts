export interface FilterResult {
  payload: unknown;
  removedCount: number;
}

const SKILL_BLOCK_PATTERN = /<skill>\s*[\s\S]*?<\/skill>/gi;
const SUPERPOWERS_LOCATION_PATTERN =
  /<location>[^<]*[/\\]\.agents[/\\]skills[/\\]superpowers[/\\][^<]*<\/location>/i;
const AVAILABLE_SKILLS_PATTERN = /<available_skills>[\s\S]*?<\/available_skills>/gi;

function stripSuperpowersSkillsFromText(text: string): { text: string; removedCount: number } {
  let removedCount = 0;

  const nextText = text.replace(AVAILABLE_SKILLS_PATTERN, (block) => {
    const filteredBlock = block.replace(SKILL_BLOCK_PATTERN, (skillBlock) => {
      if (!SUPERPOWERS_LOCATION_PATTERN.test(skillBlock)) return skillBlock;
      removedCount += 1;
      return "";
    });

    return filteredBlock
      .replace(/\n{3,}/g, "\n\n")
      .replace(
        /<available_skills>\s*<\/available_skills>/g,
        "<available_skills></available_skills>",
      );
  });

  return { text: nextText, removedCount };
}

function transformContent(content: unknown): { content: unknown; removedCount: number } {
  if (typeof content === "string") {
    const result = stripSuperpowersSkillsFromText(content);
    return { content: result.text, removedCount: result.removedCount };
  }

  if (Array.isArray(content)) {
    let removedCount = 0;
    const nextContent = content.map((item) => {
      if (!item || typeof item !== "object") return item;
      if (!("type" in item) || item.type !== "text") return item;
      if (!("text" in item) || typeof item.text !== "string") return item;

      const result = stripSuperpowersSkillsFromText(item.text);
      removedCount += result.removedCount;
      return { ...item, text: result.text };
    });

    return { content: nextContent, removedCount };
  }

  return { content, removedCount: 0 };
}

export function stripSuperpowersSkillsFromPayload(payload: unknown): FilterResult {
  if (!payload || typeof payload !== "object") {
    return { payload, removedCount: 0 };
  }

  if (!("messages" in payload) || !Array.isArray(payload.messages)) {
    return { payload, removedCount: 0 };
  }

  let removedCount = 0;
  const nextMessages = payload.messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (!("role" in message) || (message.role !== "developer" && message.role !== "system"))
      return message;
    if (!("content" in message)) return message;

    const result = transformContent(message.content);
    removedCount += result.removedCount;
    return result.removedCount > 0 ? { ...message, content: result.content } : message;
  });

  if (removedCount === 0) {
    return { payload, removedCount: 0 };
  }

  return {
    payload: { ...payload, messages: nextMessages },
    removedCount,
  };
}

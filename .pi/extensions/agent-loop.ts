import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function agentLoop(pi: ExtensionAPI): void {
  pi.on("agent_end", async (_event, ctx) => {
    const agentLoopFilePath = join(ctx.cwd, ".pi", "agent-loop.txt");

    const loopMessage = await readAgentLoopFile(agentLoopFilePath);
    if (loopMessage === undefined) {
      return;
    }

    if (ctx.isIdle()) {
      pi.sendUserMessage(loopMessage);
      return;
    }

    pi.sendUserMessage(loopMessage, { deliverAs: "followUp" });
  });
}

async function readAgentLoopFile(agentLoopFilePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(agentLoopFilePath, "utf8");
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      return undefined;
    }
    return trimmedContent;
  } catch {
    return undefined;
  }
}

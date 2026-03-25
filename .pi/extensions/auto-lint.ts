import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  let filesModified = false;

  pi.on("tool_call", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      filesModified = true;
    }
  });

  pi.on("agent_end", async () => {
    if (!filesModified) {
      return;
    }

    filesModified = false;

    const fmtResult = await pi.exec("pnpm", ["fmt"], { timeout: 30000 });
    const lintResult = await pi.exec("pnpm", ["lint:fix"], { timeout: 30000 });
    const errors: string[] = [];

    if (fmtResult.code !== 0) {
      const output = [fmtResult.stdout, fmtResult.stderr].filter(Boolean).join("\n");
      errors.push(`\`pnpm fmt\` failed (exit ${fmtResult.code}):\n${output}`);
    }

    if (lintResult.code !== 0) {
      const output = [lintResult.stdout, lintResult.stderr].filter(Boolean).join("\n");
      errors.push(`\`pnpm lint:fix\` failed (exit ${lintResult.code}):\n${output}`);
    }

    if (errors.length > 0) {
      pi.sendUserMessage(`Auto-lint detected errors. Fix them:\n\n${errors.join("\n\n")}`, {
        deliverAs: "followUp",
      });
      return;
    }

    const typecheckResult = await pi.exec("pnpm", ["typecheck"], { timeout: 60000 });
    if (typecheckResult.code !== 0) {
      const output = [typecheckResult.stdout, typecheckResult.stderr].filter(Boolean).join("\n");
      pi.sendUserMessage(
        `\`pnpm typecheck\` failed (exit ${typecheckResult.code}). Fix them:\n\n${output}`,
        { deliverAs: "followUp" },
      );
    }
  });
}

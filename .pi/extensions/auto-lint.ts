import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function isProjectFile(filePath: string): boolean {
  // Only lint files under packages/, not .pi/ or other dirs
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("packages/");
}

export default function (pi: ExtensionAPI): void {
  let filesModified = false;

  pi.on("tool_call", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input: unknown = event.input;
      if (
        typeof input === "object" &&
        input !== null &&
        "path" in input &&
        typeof input.path === "string" &&
        isProjectFile(input.path)
      ) {
        filesModified = true;
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!filesModified) {
      return;
    }

    filesModified = false;

    const packagesDir = "packages";
    const errors: string[] = [];

    const fmtResult = await pi.exec("npx", ["oxfmt", packagesDir], { timeout: 30000 });
    if (fmtResult.code !== 0) {
      const output = [fmtResult.stdout, fmtResult.stderr].filter(Boolean).join("\n").trim();
      if (output) {
        errors.push(`\`oxfmt\` failed (exit ${fmtResult.code}):\n${output}`);
      }
    }

    const lintResult = await pi.exec("npx", ["oxlint", "--fix", packagesDir], { timeout: 30000 });
    if (lintResult.code !== 0) {
      const output = [lintResult.stdout, lintResult.stderr].filter(Boolean).join("\n").trim();
      if (output) {
        errors.push(`\`oxlint --fix\` failed (exit ${lintResult.code}):\n${output}`);
      }
    }

    if (errors.length > 0) {
      pi.sendUserMessage(`Auto-lint detected errors. Fix them:\n\n${errors.join("\n\n")}`, {
        deliverAs: "followUp",
      });
      return;
    }

    const typecheckResult = await pi.exec(
      "pnpm",
      ["--filter", "webm-extension-demo", "run", "typecheck"],
      { timeout: 60000 },
    );
    if (typecheckResult.code !== 0) {
      const output = [typecheckResult.stdout, typecheckResult.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      if (output) {
        pi.sendUserMessage(
          `\`typecheck\` failed (exit ${typecheckResult.code}). Fix them:\n\n${output}`,
          { deliverAs: "followUp" },
        );
      }
    }
  });
}

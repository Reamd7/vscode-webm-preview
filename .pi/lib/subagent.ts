import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmdirSync } from "node:fs";

export interface SubagentResult {
  output: string;
  exitCode: number;
  error?: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/**
 * Spawn a subagent via `pi --mode json -p --no-session`.
 *
 * @param task  - Prompt sent to the subagent.
 * @param cwd   - Working directory.
 * @param options.systemPrompt - Optional system prompt appended via --append-system-prompt.
 * @param options.tools        - Optional tool whitelist.
 * @param options.signal       - Optional abort signal.
 */
export async function runSubagent(
  task: string,
  cwd: string,
  options: {
    systemPrompt?: string;
    tools?: string[];
    signal?: AbortSignal;
  } = {},
): Promise<SubagentResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (options.tools && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  try {
    if (options.systemPrompt) {
      tmpDir = await mkdtemp(join(tmpdir(), "pi-task-loop-"));
      tmpFile = join(tmpDir, "system-prompt.md");
      await writeFile(tmpFile, options.systemPrompt, "utf8");
      args.push("--append-system-prompt", tmpFile);
    }

    args.push(task);

    const result = await new Promise<SubagentResult>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      let stderr = "";
      let lastAssistantText = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            for (const part of event.message.content) {
              if (part.type === "text") {
                lastAssistantText = part.text;
              }
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve({
          output: lastAssistantText || "",
          exitCode: code ?? 0,
          error: code !== 0 ? stderr : undefined,
        });
      });

      proc.on("error", (err) => {
        resolve({ output: "", exitCode: 1, error: err.message });
      });

      if (options.signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (options.signal.aborted) kill();
        else options.signal.addEventListener("abort", kill, { once: true });
      }
    });

    return result;
  } finally {
    if (tmpFile)
      try {
        await unlink(tmpFile);
      } catch {
        /* ignore */
      }
    if (tmpDir)
      try {
        rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
  }
}

/**
 * subagent.ts — Subagent 派发工具
 *
 * 职责：
 * 封装 `pi --mode json -p --no-session` 的 spawn 逻辑，
 * 提供简单的接口让 extension 派发隔离的 subagent 执行任务。
 *
 * 为什么用 subagent 而不是主 agent？
 * - **上下文隔离**：subagent 有独立的上下文窗口，不会污染主对话
 * - **专注执行**：每个 subagent 只做一件事（生成 spec / 反思 / 生成报告等）
 * - **输出可控**：JSON mode 输出结构化数据，便于 extension 解析
 *
 * 工作原理：
 * 1. 构建 pi CLI 参数（--mode json -p --no-session + 可选的 --tools / --append-system-prompt）
 * 2. 通过 child_process.spawn 启动一个新的 pi 进程
 * 3. 解析 stdout 中的 JSON 事件流，提取最后一条 assistant 消息作为输出
 * 4. 返回 { output, exitCode, error }
 *
 * 关于 getPiInvocation：
 * pi 可能通过多种方式安装（全局 CLI、npm script、直接 node 运行等），
 * 这个函数检测当前的运行方式，确保 subagent 用相同的方式启动。
 */

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmdirSync } from "node:fs";

export interface SubagentResult {
  /** subagent 最后一条 assistant 消息的文本内容 */
  output: string;
  /** 进程退出码，0 = 成功 */
  exitCode: number;
  /** 非零退出码时的 stderr 内容 */
  error?: string;
}

/**
 * 检测 pi 的启动方式，返回可用于 spawn 的 command + args。
 *
 * 检测顺序：
 * 1. 如果 process.argv[1] 存在（通过 node script 运行），用 node + script 路径
 * 2. 如果 process.execPath 不是 node/bun（说明是编译后的二进制），直接用 execPath
 * 3. 兜底用全局 "pi" 命令
 */
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
 * 派发 subagent 执行任务。
 *
 * @param task    - 发送给 subagent 的 prompt 文本
 * @param cwd     - 工作目录（subagent 的 read/write/bash 都在此目录下执行）
 * @param options.systemPrompt - 可选的追加 system prompt（写入临时文件，通过 --append-system-prompt 传递）
 * @param options.tools        - 可选的工具白名单（如 ['read', 'bash']），限制 subagent 可用的工具
 * @param options.signal       - 可选的 AbortSignal，用于中途取消 subagent
 *
 * @example
 * // 用 subagent 生成任务计划（只给 read + bash 工具）
 * const result = await runSubagent(planPrompt, ctx.cwd, { tools: ['read', 'bash'] });
 * const plan = JSON.parse(result.output);
 *
 * @example
 * // 用 subagent 写入文件（需要 write 工具）
 * await runSubagent(specPrompt, ctx.cwd, { tools: ['read', 'write', 'bash'] });
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
  // 构建 pi CLI 参数
  // --mode json:  输出 JSON 事件流（而非交互式 TUI）
  // -p:           print mode，单次执行后退出
  // --no-session: 不持久化会话（subagent 是一次性的）
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  // --tools: 限制可用工具，避免 subagent 做不该做的事
  if (options.tools && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  try {
    // system prompt 需要通过临时文件传递（pi CLI 的限制）
    if (options.systemPrompt) {
      tmpDir = await mkdtemp(join(tmpdir(), "pi-task-loop-"));
      tmpFile = join(tmpDir, "system-prompt.md");
      await writeFile(tmpFile, options.systemPrompt, "utf8");
      args.push("--append-system-prompt", tmpFile);
    }

    // 最后一个参数是 prompt 文本
    args.push(task);

    const result = await new Promise<SubagentResult>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = ""; // stdout 的未完成行缓冲区
      let stderr = "";
      let lastAssistantText = "";

      /**
       * 解析 JSON 事件流中的单行。
       * pi --mode json 输出的每一行都是一个 JSON 对象，格式如：
       * {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
       *
       * 我们只关心 message_end 事件中 assistant 角色的最后一条文本消息。
       */
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
          // ignore non-JSON lines (e.g. warnings, progress output)
        }
      };

      // 流式处理 stdout：按行拆分，缓冲不完整的行
      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // 最后一段可能不完整，保留在 buffer
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        // 处理 buffer 中残余的最后一行
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

      // 支持通过 AbortSignal 中途取消 subagent
      if (options.signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          // 5 秒后如果还没退出，强制杀掉
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
    // 清理临时文件
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

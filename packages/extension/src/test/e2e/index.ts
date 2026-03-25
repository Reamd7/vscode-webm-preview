import * as vscode from "vscode";

// 简单的测试工具
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error}`);
    failed++;
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, but got ${actual}`);
      }
    },
    toBeDefined() {
      if (actual === undefined || actual === null) {
        throw new Error(`Expected value to be defined, but got ${actual}`);
      }
    },
    toBeTrue() {
      if (actual !== true) {
        throw new Error(`Expected true, but got ${actual}`);
      }
    },
    toContain(expected: string) {
      if (!Array.isArray(actual) || !actual.includes(expected)) {
        throw new Error(`Expected array to contain ${expected}`);
      }
    },
  };
}

export async function run(): Promise<void> {
  console.log("\nVSCode Extension Tests\n");

  // 先激活扩展
  const extension = vscode.extensions.getExtension("your-publisher-name.webm-extension-demo");
  if (extension && !extension.isActive) {
    await extension.activate();
  }

  // 测试 1: 扩展应该被正确激活
  await test("扩展应该被正确激活", async () => {
    const ext = vscode.extensions.getExtension("your-publisher-name.webm-extension-demo");
    expect(ext).toBeDefined();
    expect(ext?.isActive).toBeTrue();
  });

  // 测试 2: helloWebpack 命令应该已注册
  await test("helloWebpack 命令应该已注册", async () => {
    const commands = await vscode.commands.getCommands(true);
    expect(commands).toContain("extension.helloWebpack");
  });

  // 测试 3: 执行 helloWebpack 命令
  await test("执行 helloWebpack 命令", async () => {
    await vscode.commands.executeCommand("extension.helloWebpack");
  });

  console.log(`\n${passed} passing, ${failed} failing\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

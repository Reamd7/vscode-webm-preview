import { download, resolveCliPathFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";
import path from "path";

async function main() {
  try {
    const vscodeExecutablePath = await download({
      version: "stable",
    });
    const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

    const result = await runTests({
      vscodeExecutablePath,
      cliPath,
      extensionDevelopmentPath: path.resolve("."),
      extensionTestsPath: path.resolve("./dist/test/e2e/index.js"),
      launchArgs: ["--disable-extensions"],
    });

    console.log("Test result:", result);
    process.exit(result);
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

main();

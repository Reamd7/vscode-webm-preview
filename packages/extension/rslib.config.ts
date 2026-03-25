import { defineConfig } from "@rslib/core";

export default defineConfig(() => {
  return defineConfig({
    source: {
      entry: {
        extension: "./src/extension.ts",
        "test/e2e/index": "./src/test/e2e/index.ts",
      },
    },
    lib: [
      {
        format: "cjs",
        syntax: ["node 18"],
        dts: {
          tsgo: true,
        },
        autoExtension: false,
        output: {
          filename: {
            js: "[name].js",
          },
          sourceMap: {
            js: "source-map",
          },
          externals: ["vscode"],
        },
      },
    ],
  });
});

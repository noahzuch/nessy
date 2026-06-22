import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "src/": resolve(__dirname, "src") + "/",
      "tests/": resolve(__dirname, "tests") + "/",
    },
  },
});

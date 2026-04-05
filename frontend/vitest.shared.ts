import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const testingLibraryReact = fileURLToPath(
  new URL("./node_modules/@testing-library/react", import.meta.url),
);
const testingLibraryUserEvent = fileURLToPath(
  new URL("./node_modules/@testing-library/user-event", import.meta.url),
);

export function createVitestConfig(include: string[]) {
  return defineConfig({
    plugins: [react()],
    resolve: {
      alias: {
        "@testing-library/react": testingLibraryReact,
        "@testing-library/user-event": testingLibraryUserEvent,
      },
    },
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
    test: {
      environment: "jsdom",
      css: true,
      setupFiles: "./vitest.setup.ts",
      include,
      restoreMocks: true,
      clearMocks: true,
    },
  });
}

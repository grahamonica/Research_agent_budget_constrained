import { createVitestConfig } from "./vitest.shared";

export default createVitestConfig([
  "../tests/frontend/unit/**/*.test.ts",
  "../tests/frontend/unit/**/*.test.tsx",
  "../tests/frontend/integration/**/*.test.ts",
  "../tests/frontend/integration/**/*.test.tsx",
]);

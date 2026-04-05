import { createVitestConfig } from "./vitest.shared";

export default createVitestConfig([
  "../tests/frontend/integration/**/*.test.ts",
  "../tests/frontend/integration/**/*.test.tsx",
]);

import { createVitestConfig } from "./vitest.shared";

export default createVitestConfig([
  "../tests/frontend/unit/**/*.test.ts",
  "../tests/frontend/unit/**/*.test.tsx",
]);

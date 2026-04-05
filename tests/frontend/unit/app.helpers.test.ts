import { describe, expect, it } from "vitest";

import {
  buildGraphLevels,
  DEMO_SNAPSHOT,
  formatMoney,
  formatPercent,
  isTerminalStatus,
} from "../../../frontend/src/App";

describe("frontend helpers", () => {
  it("formats money using three decimal places", () => {
    expect(formatMoney(0.05)).toBe("$0.050");
    expect(formatMoney(1.23456)).toBe("$1.235");
  });

  it("formats scores as rounded percentages", () => {
    expect(formatPercent(0.834)).toBe("83%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("builds graph levels in the expected left-to-right order", () => {
    const levels = buildGraphLevels(DEMO_SNAPSHOT.graph);

    expect(levels.map((level) => level[0].type)).toEqual([
      "query",
      "subquestion",
      "category",
      "paper",
      "finding",
      "final",
    ]);
  });

  it("identifies terminal statuses correctly", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("partial")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("queued")).toBe(false);
  });
});

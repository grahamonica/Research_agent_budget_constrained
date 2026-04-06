import { describe, expect, it } from "vitest";

import {
  buildGraphLevels,
  formatMoney,
  formatPercent,
  isTerminalStatus,
} from "../../../frontend/src/App";

describe("frontend helpers", () => {
  it("formats money using four decimal places", () => {
    expect(formatMoney(0.05)).toBe("$0.0500");
    expect(formatMoney(1.23456)).toBe("$1.2346");
  });

  it("formats scores as rounded percentages", () => {
    expect(formatPercent(0.834)).toBe("83%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(null)).toBe("0%");
  });

  it("builds graph levels in the expected left-to-right order", () => {
    const levels = buildGraphLevels({
      nodes: [
        { id: "q", label: "Query", type: "query", status: "completed", score: 1, metadata: {} },
        { id: "sq", label: "Subquestion", type: "subquestion", status: "active", score: null, metadata: {} },
        { id: "paper", label: "Paper", type: "paper", status: "completed", score: 0.7, metadata: {} },
        { id: "finding", label: "Finding", type: "finding", status: "completed", score: 0.8, metadata: {} },
        { id: "final", label: "Final", type: "final", status: "idle", score: null, metadata: {} },
      ],
      edges: [],
    });

    expect(levels.map((level) => level[0].type)).toEqual([
      "query",
      "subquestion",
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

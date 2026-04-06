import { expect, test } from "@playwright/test";

async function runResearchSession(page: Parameters<typeof test>[0]["page"]) {
  await page.goto("/");
  await page.getByLabel("Research Query").fill(
    "What are the main limitations of retrieval-augmented generation systems?",
  );
  await page.getByRole("button", { name: "Run Research" }).click();

  await expect(page.locator(".allocation-panel")).toBeVisible();
  await expect(page.locator(".final-card")).toBeVisible();
  await expect(
    page.locator(".event-row").filter({
      hasText: /pruned \d+ paper branches and kept \d+ for deeper reading/i,
    }).first(),
  ).toBeVisible();
  await expect(page.locator(".graph-svg.graph-svg-ready")).toBeVisible();
}

test.describe("Research agent app", () => {
  test("starts without demo state", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByLabel("Research Query")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Run Research" })).toBeDisabled();
    await expect(
      page.getByText("Run a query to watch the agent explore papers, prune weak branches, and retain findings."),
    ).toBeVisible();
    await expect(page.getByText("demo_session")).toHaveCount(0);
  });

  test("runs a session end to end in chromium", async ({ page }) => {
    await runResearchSession(page);

    await expect(page.getByText(/retrieve papers for sq_0/i)).toBeVisible();
    await expect(page.locator(".final-text")).toContainText(/retrieved noise|context window|latency/i);
    expect(await page.locator(".finding-card").count()).toBeGreaterThanOrEqual(3);
    await expect(page.getByText("Live updates closed and the latest session snapshot could not be fetched.")).toHaveCount(0);
  });

  test("keeps nodes visible, papers inside findings, and edges normalized", async ({ page }) => {
    await runResearchSession(page);

    const graphChecks = await page.locator(".graph-viewport").evaluate((graphViewport) => {
      const viewportRect = graphViewport.getBoundingClientRect();
      const nodeGroups = [...graphViewport.querySelectorAll<SVGGElement>(".graph-svg > g:not(.edge-layer)")];
      const nodeData = nodeGroups.map((group) => {
        const phase = group.querySelector("text")?.textContent?.trim().toLowerCase() ?? "";
        const rect = group.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const vx = viewportRect.left + viewportRect.width / 2;
        const vy = viewportRect.top + viewportRect.height / 2;
        return {
          phase,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          radius: Math.hypot(cx - vx, cy - vy),
        };
      });

      const paperRadii = nodeData.filter((node) => node.phase === "paper").map((node) => node.radius);
      const findingRadii = nodeData.filter((node) => node.phase === "finding").map((node) => node.radius);
      const nodesWithinViewport = nodeData.every(
        (node) =>
          node.left >= viewportRect.left - 1 &&
          node.top >= viewportRect.top - 1 &&
          node.right <= viewportRect.right + 1 &&
          node.bottom <= viewportRect.bottom + 1,
      );

      const edgeLayer = graphViewport.querySelector(".edge-layer");
      const firstNode = graphViewport.querySelector(".graph-svg > g:not(.edge-layer)");
      const edgeIsBeforeNodes = !!edgeLayer && !!firstNode && !!(edgeLayer.compareDocumentPosition(firstNode) & Node.DOCUMENT_POSITION_FOLLOWING);

      const edgePaths = [...graphViewport.querySelectorAll<SVGPathElement>(".edge-layer path")];
      const markerPath = graphViewport.querySelector<SVGPathElement>("marker#arrow path");
      const uniformMarkerUsage = edgePaths.every((path) => path.getAttribute("marker-end") === "url(#arrow)");
      const consistentMarkerFill = markerPath?.getAttribute("fill") === "context-stroke";

      return {
        nodeCount: nodeData.length,
        nodesWithinViewport,
        maxPaperRadius: paperRadii.length ? Math.max(...paperRadii) : 0,
        minFindingRadius: findingRadii.length ? Math.min(...findingRadii) : Number.POSITIVE_INFINITY,
        edgeIsBeforeNodes,
        uniformMarkerUsage,
        consistentMarkerFill,
      };
    });

    expect(graphChecks.nodeCount).toBeGreaterThan(0);
    expect(graphChecks.nodesWithinViewport).toBe(true);
    expect(graphChecks.maxPaperRadius).toBeLessThan(graphChecks.minFindingRadius);
    expect(graphChecks.edgeIsBeforeNodes).toBe(true);
    expect(graphChecks.uniformMarkerUsage).toBe(true);
    expect(graphChecks.consistentMarkerFill).toBe(true);
  });
});

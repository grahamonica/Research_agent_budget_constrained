import { expect, test } from "@playwright/test";

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
    await page.goto("/");

    await page.getByLabel("Research Query").fill(
      "What are the main limitations of retrieval-augmented generation systems?",
    );
    await page.getByRole("button", { name: "Run Research" }).click();

    await expect(page.locator(".allocation-panel")).toBeVisible();
    await expect(page.getByText(/retrieve papers for sq_0/i)).toBeVisible();
    await expect(page.locator(".event-row").filter({
      hasText: /pruned \d+ paper branches and kept \d+ for deeper reading/i,
    }).first()).toBeVisible();
    await expect(page.locator(".final-card")).toBeVisible();
    await expect(page.locator(".final-text")).toContainText(/retrieved noise|context window|latency/i);
    expect(await page.locator(".finding-card").count()).toBeGreaterThanOrEqual(3);
    await expect(page.getByText("Live updates closed and the latest session snapshot could not be fetched.")).toHaveCount(0);
  });
});

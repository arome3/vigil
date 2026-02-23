import { test, expect } from "@playwright/test";

test.describe("Scenario 1: Compromised API Key", () => {
  test("dashboard shows metric tiles", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Active Incidents")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("MTTR (24h)")).toBeVisible();
    await expect(page.getByText("Alerts Suppressed")).toBeVisible();
    await expect(page.getByText("Reflection Loops")).toBeVisible();
  });

  test("incident list shows INC-2026-00142", async ({ page }) => {
    await page.goto("/incidents");
    await expect(page.getByText("INC-2026-00142")).toBeVisible({ timeout: 10000 });
  });

  test("incident detail loads and shows header", async ({ page }) => {
    await page.goto("/incidents/INC-2026-00142");
    await expect(page.getByText("INC-2026-00142")).toBeVisible({ timeout: 10000 });
    // Tabs should be present — use role selector to be specific
    const tabsList = page.locator("[role='tablist']");
    await expect(tabsList).toBeVisible();
    await expect(tabsList.getByText("Timeline")).toBeVisible();
  });

  test("incident detail shows action buttons", async ({ page }) => {
    await page.goto("/incidents/INC-2026-00142");
    await expect(page.getByRole("button", { name: "Escalate" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Suppress" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export" })).toBeVisible();
  });

  test("incident detail shows timing metrics sidebar", async ({ page }) => {
    await page.goto("/incidents/INC-2026-00142");
    await expect(page.getByText("Timing Metrics")).toBeVisible({ timeout: 10000 });
    // Use first() since TTD/TTI/TTR/TTV appear both in sidebar and potentially in tooltips
    await expect(page.getByText("TTD").first()).toBeVisible();
    await expect(page.getByText("TTR").first()).toBeVisible();
    await expect(page.getByText("TTV").first()).toBeVisible();
  });

  test("trace view shows agent tree", async ({ page }) => {
    await page.goto("/incidents/INC-2026-00142/trace");
    await expect(page.getByText("Agent Trace")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("INC-2026-00142")).toBeVisible();
  });
});

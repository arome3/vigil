import { test, expect } from "@playwright/test";

test.describe("Scenario 2: Bad Deployment", () => {
  test("dashboard shows change correlation section", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Change Correlations")).toBeVisible({ timeout: 10000 });
  });

  test("incident list shows INC-2026-00143", async ({ page }) => {
    await page.goto("/incidents");
    await expect(page.getByText("INC-2026-00143")).toBeVisible({ timeout: 10000 });
  });

  test("incident detail loads for bad deployment", async ({ page }) => {
    await page.goto("/incidents/INC-2026-00143");
    await expect(page.getByText("INC-2026-00143")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("operational")).toBeVisible();
  });
});

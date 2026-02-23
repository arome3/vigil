import { test, expect } from "@playwright/test";

async function dismissErrorOverlay(page: import("@playwright/test").Page) {
  try {
    const closeButton = page.locator("nextjs-portal").getByRole("button", { name: /close/i });
    if (await closeButton.isVisible({ timeout: 1000 })) {
      await closeButton.click();
    }
  } catch {
    // No overlay present
  }
}

test.describe("Approval Flow", () => {
  test("incident detail has escalate and suppress buttons", async ({ page }) => {
    await page.goto("/incidents/INC-2026-00142");
    await dismissErrorOverlay(page);
    await expect(page.getByText("Escalate")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Suppress")).toBeVisible();
  });

  test("incident detail loads with correct ID", async ({ page }) => {
    await page.goto("/incidents/INC-2026-00142");
    await dismissErrorOverlay(page);
    await expect(page.getByText("INC-2026-00142")).toBeVisible({ timeout: 10000 });
  });
});

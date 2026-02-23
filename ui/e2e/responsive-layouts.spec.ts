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

test.describe("Responsive Layouts", () => {
  test("mobile viewport shows bottom nav", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await dismissErrorOverlay(page);
    // Bottom nav should be visible on mobile (has class md:hidden)
    const bottomNav = page.locator("nav").last();
    await expect(bottomNav).toBeVisible({ timeout: 5000 });
  });

  test("desktop viewport shows header with VIGIL", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await dismissErrorOverlay(page);
    await expect(page.getByText("VIGIL")).toBeVisible({ timeout: 5000 });
  });

  test("tablet layout renders dashboard content", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/");
    await dismissErrorOverlay(page);
    await expect(page.getByText("Active Incidents")).toBeVisible({ timeout: 10000 });
  });

  test("wide viewport renders full dashboard", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await dismissErrorOverlay(page);
    await expect(page.getByText("Active Incidents")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("MTTR (24h)")).toBeVisible();
  });

  test("incident list loads on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/incidents");
    await dismissErrorOverlay(page);
    await expect(page.getByText("INC-2026-00142")).toBeVisible({ timeout: 10000 });
  });
});

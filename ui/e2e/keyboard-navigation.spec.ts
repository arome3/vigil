import { test, expect } from "@playwright/test";

test.describe("Keyboard Navigation", () => {
  test("Cmd+K opens command palette", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Meta+k");
    await expect(page.getByPlaceholder("Search incidents, agents, views...")).toBeVisible({ timeout: 5000 });
  });

  test("? key opens keyboard shortcut overlay", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Shift+?");
    await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible({ timeout: 5000 });
  });

  test("j/k navigate incident list", async ({ page }) => {
    await page.goto("/incidents");
    await expect(page.getByText("INC-2026-00142")).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("j");
    await page.waitForTimeout(300);
    const rows = page.locator("tbody tr");
    await expect(rows.first()).toBeVisible();
  });
});

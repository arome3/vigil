import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("Accessibility", () => {
  test("dashboard has no critical a11y violations", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(3000);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .disableRules(["color-contrast", "aria-valid-attr-value"]) // Radix aria-controls on lazy tabs
      .analyze();

    const critical = results.violations.filter((v) => v.impact === "critical");
    expect(critical).toHaveLength(0);
  });

  test("incidents page has no critical a11y violations", async ({ page }) => {
    await page.goto("/incidents");
    await page.waitForTimeout(3000);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .disableRules(["color-contrast", "aria-valid-attr-value"])
      .analyze();

    const critical = results.violations.filter((v) => v.impact === "critical");
    expect(critical).toHaveLength(0);
  });

  test("agents page has no critical a11y violations", async ({ page }) => {
    await page.goto("/agents");
    await page.waitForTimeout(3000);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .disableRules(["color-contrast", "aria-valid-attr-value"])
      .analyze();

    const critical = results.violations.filter((v) => v.impact === "critical");
    expect(critical).toHaveLength(0);
  });

  test("skip link exists in DOM", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1000);
    const skipLink = page.locator("a[href='#main-content']");
    await expect(skipLink).toBeAttached();
  });

  test("main content landmark exists", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1000);
    const main = page.locator("main#main-content");
    await expect(main).toBeAttached();
  });
});

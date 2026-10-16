import { expect, test } from "@playwright/test";

const DEMO_DISCLAIMER =
  "DEMO APPLICATION - No real reservations are made and no payments are processed.";

test("the wizard welcome page renders and the permanent disclaimer is visible", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/AI Travel Planner/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Plan one sightseeing day");
  await expect(page.getByText(DEMO_DISCLAIMER, { exact: true }).first()).toBeVisible();
});

test("permanent disclaimer is present in header, footer, and body", async ({ page }) => {
  await page.goto("/");
  const banners = page.getByText(DEMO_DISCLAIMER, { exact: true });
  await expect(banners).toHaveCount(3);
});

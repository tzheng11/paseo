import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function closeMenuSheet(page: Page): Promise<void> {
  const backdrop = page.getByRole("button", { name: "Bottom sheet backdrop" }).first();
  await backdrop.click({ position: { x: 12, y: 12 } });
  await expect(backdrop).not.toBeVisible({ timeout: 10_000 });
}

test("project and workspace kebabs open action sheets on compact layouts", async ({ page }) => {
  const seeded = await seedWorkspace({ repoPrefix: "sidebar-mobile-menu-sheet-" });
  let secondProject: Awaited<ReturnType<typeof seedWorkspace>> | null = null;

  try {
    // Project filtering appears only with multiple projects. Establish that menu
    // shape explicitly rather than depending on earlier specs' daemon inventory.
    secondProject = await seedWorkspace({ repoPrefix: "sidebar-mobile-menu-second-project-" });
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await waitForSidebarHydration(page);
    for (const project of [seeded, secondProject]) {
      await expect(
        page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(project.projectKey)}`),
      ).toBeVisible();
    }

    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByRole("menuitem")).toHaveText([
      /^Grouping/,
      /^Sort/,
      /^Title/,
      "Show",
      "Project",
      "Show background",
    ]);
    await closeMenuSheet(page);

    await page
      .getByTestId(`sidebar-project-kebab-${projectEquivalenceViewKey(seeded.projectKey)}`)
      .click();

    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Project actions", { exact: true })).toBeVisible();
    await closeMenuSheet(page);

    const workspaceRow = page.getByTestId(
      `sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`,
    );
    await workspaceRow.hover();
    await workspaceRow
      .getByTestId(`sidebar-workspace-kebab-${getServerId()}:${seeded.workspaceId}`)
      .click();

    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Workspace actions", { exact: true })).toBeVisible();
  } finally {
    await secondProject?.cleanup();
    await seeded.cleanup();
  }
});

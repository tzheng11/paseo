import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function rowTestIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

async function visibleBoundingBox(row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error("Expected a visible draggable row");
  return box;
}

async function pressProjectRow(rows: Locator) {
  await rows.page().mouse.down();
}

async function pressWorkspaceRow(rows: Locator) {
  const solidScrimStop = rows
    .nth(0)
    .getByTestId("sidebar-workspace-trailing-scrim")
    .locator("stop")
    .nth(1);
  const hoverScrimColor = await solidScrimStop.getAttribute("stop-color");
  await rows.page().mouse.down();
  await expect.poll(() => solidScrimStop.getAttribute("stop-color")).not.toBe(hoverScrimColor);
}

async function quickDragFirstRowAfterSecond(
  rows: Locator,
  pressRow: (rows: Locator) => Promise<void>,
) {
  await expect(rows).toHaveCount(2);
  const before = await rowTestIds(rows);
  const sourceBox = await visibleBoundingBox(rows.nth(0));
  const targetBox = await visibleBoundingBox(rows.nth(1));

  const page = rows.page();
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(source.x, source.y);
  const trailingScrim = rows.nth(0).getByTestId("sidebar-workspace-trailing-scrim");
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await expect(trailingScrim).toHaveCount(0);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
}

test("projects, workspaces, and pinned chats reorder with an immediate mouse drag", async ({
  page,
}) => {
  const firstProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-first-" });
  const secondProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-second-" });

  try {
    const secondWorkspace = await firstProject.client.createWorkspace({
      source: {
        kind: "directory",
        path: firstProject.repoPath,
        projectId: firstProject.projectId,
      },
      title: "Second workspace",
    });
    if (!secondWorkspace.workspace) {
      throw new Error(secondWorkspace.error ?? "Failed to seed a second workspace");
    }

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const firstProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(firstProject.projectKey)}`;
    const secondProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(secondProject.projectKey)}`;
    await quickDragFirstRowAfterSecond(
      page.locator(`[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`),
      pressProjectRow,
    );
    const firstWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${firstProject.workspaceId}`;
    const secondWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondWorkspace.workspace.id}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );

    await firstProject.client.setWorkspacePinned(firstProject.workspaceId, true);
    await secondProject.client.setWorkspacePinned(secondProject.workspaceId, true);
    const secondProjectWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondProject.workspaceId}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );
  } finally {
    await firstProject.cleanup();
    await secondProject.cleanup();
  }
});

test("pinned A–Z sorting persists, follows renames, and restores manual order", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const zeta = await seedWorkspace({
    title: "Zeta pinned",
    repoPrefix: "pinned-sort-zeta-",
  });
  const alpha = await seedWorkspace({
    title: "Alpha pinned",
    repoPrefix: "pinned-sort-alpha-",
  });
  try {
    await alpha.client.setWorkspacePinned(alpha.workspaceId, true);
    await zeta.client.setWorkspacePinned(zeta.workspaceId, true);
    await page.setViewportSize({ width: 1440, height: 1200 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const section = page.getByTestId("sidebar-pinned-section").filter({ visible: true }).first();
    const zetaRow = section.getByTestId(
      `sidebar-workspace-row-${getServerId()}:${zeta.workspaceId}`,
    );
    const alphaRow = section.getByTestId(
      `sidebar-workspace-row-${getServerId()}:${alpha.workspaceId}`,
    );
    const sort = section.getByTestId("sidebar-pinned-sort");
    async function expectAbove(first: Locator, second: Locator) {
      await expect
        .poll(async () => {
          const firstBox = await first.boundingBox();
          const secondBox = await second.boundingBox();
          return firstBox && secondBox ? firstBox.y < secondBox.y : false;
        })
        .toBe(true);
    }
    await expectAbove(zetaRow, alphaRow);
    await sort.click();
    await page.getByTestId("sidebar-pinned-sort-alphabetical").click();
    await expectAbove(alphaRow, zetaRow);
    await expect(sort).toContainText("A–Z");
    await page.reload();
    await expect(sort).toContainText("A–Z");
    await expectAbove(alphaRow, zetaRow);
    await sort.click();
    await page.getByTestId("sidebar-pinned-sort-manual").click();
    await expectAbove(zetaRow, alphaRow);
    await sort.click();
    await page.getByTestId("sidebar-pinned-sort-alphabetical").click();
    await alpha.client.setWorkspaceTitle(alpha.workspaceId, "Zulu renamed");
    await expect(alphaRow).toContainText("Zulu renamed");
    await expectAbove(zetaRow, alphaRow);
    await page.mouse.move(1000, 800);
    await page.screenshot({
      path: "../../artifacts/pinned-workspace-sort.png",
      animations: "disabled",
    });
  } finally {
    await Promise.all([zeta.cleanup(), alpha.cleanup()]);
  }
});

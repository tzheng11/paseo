import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
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
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height * 0.88 };

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

test("project sorts are independent, persist, and restore manual order", async ({ page }) => {
  test.setTimeout(120_000);
  const first = await seedWorkspace({
    title: "Zeta project workspace",
    repoPrefix: "project-sort-first-",
  });
  const second = await seedWorkspace({
    title: "Zeta other workspace",
    repoPrefix: "project-sort-second-",
  });
  const pinned = await seedWorkspace({
    title: "Pinned workspace",
    repoPrefix: "project-sort-pinned-",
  });
  try {
    const firstAlpha = await first.client.createWorkspace({
      source: { kind: "directory", path: first.repoPath, projectId: first.projectId },
      title: "Alpha project workspace",
    });
    const secondAlpha = await second.client.createWorkspace({
      source: { kind: "directory", path: second.repoPath, projectId: second.projectId },
      title: "Alpha other workspace",
    });
    if (!firstAlpha.workspace || !secondAlpha.workspace)
      throw new Error("Failed to seed sorting workspaces");
    await pinned.client.setWorkspacePinned(pinned.workspaceId, true);
    await page.setViewportSize({ width: 1440, height: 1200 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const firstSortId = `sidebar-project-sort-${projectEquivalenceViewKey(first.projectKey)}`;
    const secondSortId = `sidebar-project-sort-${projectEquivalenceViewKey(second.projectKey)}`;
    const firstSort = page.getByTestId(firstSortId).filter({ visible: true }).first();
    const secondSort = page.getByTestId(secondSortId).filter({ visible: true }).first();
    const pinnedSort = page.getByTestId("sidebar-pinned-sort").filter({ visible: true }).first();
    const zetaId = `sidebar-workspace-row-${getServerId()}:${first.workspaceId}`;
    const alphaId = `sidebar-workspace-row-${getServerId()}:${firstAlpha.workspace.id}`;
    const rows = page.locator(`[data-testid="${zetaId}"], [data-testid="${alphaId}"]`);
    const otherRows = page.locator(
      `[data-testid="sidebar-workspace-row-${getServerId()}:${second.workspaceId}"], [data-testid="sidebar-workspace-row-${getServerId()}:${secondAlpha.workspace.id}"]`,
    );
    await expect(rows).toHaveCount(2);
    await expect(otherRows).toHaveCount(2);
    const otherManualOrder = await rowTestIds(otherRows);

    await firstSort.click();
    await page.getByTestId(`${firstSortId}-alphabetical`).click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    const alphaTreeRow = page.getByTestId(
      `sidebar-workspace-tree-row-${getServerId()}:${firstAlpha.workspace.id}`,
    );
    await expect(alphaTreeRow).toHaveAttribute("aria-disabled", "true");
    const source = await visibleBoundingBox(rows.nth(0));
    const target = await visibleBoundingBox(rows.nth(1));
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.88, {
      steps: 4,
    });
    await page.mouse.up();
    await expect(firstSort).toContainText("A–Z");
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await page.getByTestId("workspace-tree-use-manual-order").click();
    await expect(firstSort).toContainText("Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);

    await firstSort.click();
    await page.getByTestId(`${firstSortId}-alphabetical`).click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await expect(secondSort).toContainText("Manual");
    await expect(pinnedSort).toContainText("Manual");
    await expect.poll(() => rowTestIds(otherRows)).toEqual(otherManualOrder);

    await page.reload();
    await waitForSidebarHydration(page);
    await expect(firstSort).toContainText("A–Z");
    await expect(secondSort).toContainText("Manual");
    await expect(pinnedSort).toContainText("Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await firstSort.click();
    await page.getByTestId(`${firstSortId}-manual`).click();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await expect.poll(() => rowTestIds(otherRows)).toEqual(otherManualOrder);
  } finally {
    await Promise.all([first.cleanup(), second.cleanup(), pinned.cleanup()]);
  }
});

test("Last Activity follows live agent activity in project and Pinned lists", async ({ page }) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({
    title: "Zeta activity",
    repoPrefix: "project-activity-sort-",
  });
  try {
    const alpha = await project.client.createWorkspace({
      source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
      title: "Alpha activity",
    });
    if (!alpha.workspace) throw new Error(alpha.error ?? "Failed to seed activity workspace");
    const olderAgent = await project.client.createAgent({
      provider: "mock",
      cwd: project.repoPath,
      workspaceId: project.workspaceId,
      title: "Zeta worker",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    await project.client.createAgent({
      provider: "mock",
      cwd: project.repoPath,
      workspaceId: alpha.workspace.id,
      title: "Alpha worker",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    await page.setViewportSize({ width: 1440, height: 1200 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const projectSortId = `sidebar-project-sort-${projectEquivalenceViewKey(project.projectKey)}`;
    const projectSort = page.getByTestId(projectSortId).filter({ visible: true }).first();
    const zetaId = `sidebar-workspace-row-${getServerId()}:${project.workspaceId}`;
    const alphaId = `sidebar-workspace-row-${getServerId()}:${alpha.workspace.id}`;
    const rows = page.locator(`[data-testid="${zetaId}"], [data-testid="${alphaId}"]`);
    await projectSort.click();
    await page.getByTestId(`${projectSortId}-activity`).click();
    await expect(projectSort).toContainText("Last Activity");
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await project.client.sendAgentMessage(olderAgent.id, "Update this workspace's activity.");
    await project.client.waitForFinish(olderAgent.id, 20_000);
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);

    await project.client.setWorkspacePinned(project.workspaceId, true);
    await project.client.setWorkspacePinned(alpha.workspace.id, true);
    const pinnedSort = page.getByTestId("sidebar-pinned-sort").filter({ visible: true }).first();
    await pinnedSort.click();
    await page.getByTestId("sidebar-pinned-sort-activity").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await page.reload();
    await waitForSidebarHydration(page);
    await expect(pinnedSort).toContainText("Last Activity");
    await expect(projectSort).toContainText("Last Activity");
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
  } finally {
    await project.cleanup();
  }
});

function rewriteWorkspaceTimes(value: unknown, times: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteWorkspaceTimes(item, times));
  if (!value || typeof value !== "object") return value;
  const original = value as Record<string, unknown>;
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(original))
    rewritten[key] = rewriteWorkspaceTimes(child, times);
  if (typeof original.id === "string" && times.has(original.id) && "statusEnteredAt" in original)
    rewritten.statusEnteredAt = times.get(original.id);
  return rewritten;
}

async function workspaceTimestampFixture(page: Page, times: ReadonlyMap<string, string>) {
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      browser.send(JSON.stringify(rewriteWorkspaceTimes(JSON.parse(raw), times)));
    });
  });
}

async function enableSidebarTimestamps(page: Page) {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await page.getByTestId("sidebar-display-show").click();
  const option = page.getByTestId("sidebar-workspace-trailing-timestamp");
  if ((await option.getAttribute("aria-checked")) !== "true") await option.click();
  await page.keyboard.press("Escape");
}

async function displayedWorkspaceAges(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map(
      (element) =>
        element.querySelector('[data-testid="sidebar-workspace-timestamp"]')?.textContent,
    ),
  );
}

test("Last Activity matches the displayed workspace ages despite fresh agent metadata", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({
    title: "A · old workspace, fresh metadata",
    repoPrefix: "workspace-clock-sort-",
  });
  try {
    const recent = await project.client.createWorkspace({
      source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
      title: "Z · most recent workspace",
    });
    const middle = await project.client.createWorkspace({
      source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
      title: "M · middle workspace",
    });
    if (!recent.workspace || !middle.workspace) throw new Error("Missing timestamp fixtures");
    await project.client.createAgent({
      provider: "mock",
      cwd: project.repoPath,
      workspaceId: project.workspaceId,
      title: "Fresh metadata on old workspace",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    const now = Date.now();
    await page.clock.setFixedTime(new Date(now));
    await workspaceTimestampFixture(
      page,
      new Map([
        [project.workspaceId, new Date(now - 2 * 86_400_000).toISOString()],
        [middle.workspace.id, new Date(now - 2 * 3_600_000).toISOString()],
        [recent.workspace.id, new Date(now - 10_000).toISOString()],
      ]),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await enableSidebarTimestamps(page);
    const key = (id: string) => `sidebar-workspace-row-${getServerId()}:${id}`;
    const ids = [key(recent.workspace.id), key(middle.workspace.id), key(project.workspaceId)];
    const rows = page.locator(ids.map((id) => `[data-testid="${id}"]`).join(","));
    const sortId = `sidebar-project-sort-${projectEquivalenceViewKey(project.projectKey)}`;
    await page.getByTestId(sortId).click();
    await page.getByTestId(`${sortId}-activity`).click();
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await expect.poll(() => displayedWorkspaceAges(rows)).toEqual(["now", "2h", "2d"]);
    for (const id of [project.workspaceId, middle.workspace.id, recent.workspace.id])
      await project.client.setWorkspacePinned(id, true);
    await page.getByTestId("sidebar-pinned-sort").click();
    await page.getByTestId("sidebar-pinned-sort-activity").click();
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await expect.poll(() => displayedWorkspaceAges(rows)).toEqual(["now", "2h", "2d"]);
    await page.reload();
    await waitForSidebarHydration(page);
    await expect(page.getByTestId("sidebar-pinned-sort")).toContainText("Last Activity");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await expect.poll(() => displayedWorkspaceAges(rows)).toEqual(["now", "2h", "2d"]);
    await page.mouse.move(1100, 100);
    await page.screenshot({ path: testInfo.outputPath("last-activity-visible-age-order.png") });
  } finally {
    await project.cleanup();
  }
});

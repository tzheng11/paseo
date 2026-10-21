import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";

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
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height * 0.9 };

  await page.mouse.move(source.x, source.y);
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
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

async function dragWorkspace(
  page: Page,
  sourceId: string,
  targetId: string,
  position: "before" | "inside" | "after",
) {
  const source = page
    .getByTestId(`workspace-tree-drag-${getServerId()}:${sourceId}`)
    .filter({ visible: true })
    .first();
  const target = page
    .getByTestId(`workspace-tree-node-${getServerId()}:${targetId}`)
    .filter({ visible: true })
    .first();
  await source.scrollIntoViewIfNeeded();
  const from = await visibleBoundingBox(source);
  const to = await visibleBoundingBox(target);
  const fraction = { before: 0.1, inside: 0.5, after: 0.9 }[position];
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 2 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * fraction, { steps: 8 });
  await expect(page.getByTestId(`workspace-tree-drop-${position}`)).toBeVisible();
  await page.mouse.up();
}

test("dragging nests and orders siblings, moves whole subtrees, and survives reload", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const seeded = await seedWorkspace({ repoPrefix: "workspace-tree-", title: "Parent" });
  async function create(title: string, parentWorkspaceId: string | null = null) {
    const response = await seeded.client.createWorkspace({
      source: { kind: "directory", path: seeded.repoPath, projectId: seeded.projectId },
      title,
      parentWorkspaceId,
    });
    if (!response.workspace) throw new Error(response.error ?? "Workspace creation failed");
    return response.workspace.id;
  }
  async function hierarchy(id: string) {
    const snapshot = await seeded.client.fetchWorkspaces({
      filter: { projectId: seeded.projectId },
    });
    const workspace = snapshot.entries.find((entry) => entry.id === id);
    if (!workspace) throw new Error("Workspace missing from directory");
    return { parentWorkspaceId: workspace.parentWorkspaceId, siblingOrder: workspace.siblingOrder };
  }
  try {
    const first = await create("First child", seeded.workspaceId);
    const last = await create("Last child");
    const between = await create("Between children");
    await page.setViewportSize({ width: 1440, height: 1100 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await dragWorkspace(page, last, seeded.workspaceId, "inside");
    await expect
      .poll(async () => (await hierarchy(last)).parentWorkspaceId)
      .toBe(seeded.workspaceId);
    const firstRank = (await hierarchy(first)).siblingOrder!;
    const lastRank = (await hierarchy(last)).siblingOrder!;
    await dragWorkspace(page, between, last, "before");
    await expect
      .poll(() => hierarchy(between))
      .toEqual({ parentWorkspaceId: seeded.workspaceId, siblingOrder: (firstRank + lastRank) / 2 });
    const grandchild = await create("Grandchild", last);
    await dragWorkspace(page, last, between, "inside");
    await expect.poll(async () => (await hierarchy(last)).parentWorkspaceId).toBe(between);
    expect((await hierarchy(grandchild)).parentWorkspaceId).toBe(last);
    await dragWorkspace(page, last, seeded.workspaceId, "before");
    await expect.poll(async () => (await hierarchy(last)).parentWorkspaceId).toBe(null);
    await seeded.client.setWorkspacePinned(last, true);
    await seeded.client.setWorkspacePinned(seeded.workspaceId, true);
    const pinned = page.getByTestId("sidebar-pinned-section").filter({ visible: true }).first();
    await expect(
      pinned.getByTestId(`workspace-tree-node-${getServerId()}:${grandchild}`),
    ).toBeVisible();
    await expect(
      page
        .getByTestId(`workspace-tree-node-${getServerId()}:${grandchild}`)
        .filter({ visible: true }),
    ).toHaveCount(1);
    await page
      .getByTestId(`workspace-tree-toggle-${getServerId()}:${last}`)
      .filter({ visible: true })
      .click();
    await expect(
      page
        .getByTestId(`workspace-tree-node-${getServerId()}:${grandchild}`)
        .filter({ visible: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByTestId(`workspace-tree-toggle-${getServerId()}:${last}`).filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId(`workspace-tree-node-${getServerId()}:${grandchild}`)
        .filter({ visible: true }),
    ).toHaveCount(0);
    await page
      .getByTestId(`workspace-tree-toggle-${getServerId()}:${last}`)
      .filter({ visible: true })
      .click();
    await expect(
      pinned.getByTestId(`workspace-tree-node-${getServerId()}:${grandchild}`),
    ).toBeVisible();
    expect((await hierarchy(grandchild)).parentWorkspaceId).toBe(last);
    await page.mouse.move(1000, 900);
    await page.screenshot({
      path: testInfo.outputPath("workspace-hierarchy.png"),
      animations: "disabled",
    });
    const arriving = await create("Move between sections");
    const unpinnedParent = await create("Unpinned parent");
    await dragWorkspace(page, arriving, last, "before");
    await expect(
      pinned.getByTestId(`workspace-tree-node-${getServerId()}:${arriving}`),
    ).toBeVisible();
    await dragWorkspace(page, arriving, unpinnedParent, "before");
    await expect(
      pinned.getByTestId(`workspace-tree-node-${getServerId()}:${arriving}`),
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId(`workspace-tree-node-${getServerId()}:${arriving}`)
        .filter({ visible: true }),
    ).toBeVisible();
    await dragWorkspace(page, last, unpinnedParent, "inside");
    await expect.poll(async () => (await hierarchy(last)).parentWorkspaceId).toBe(unpinnedParent);
    await expect(pinned.getByTestId(`workspace-tree-node-${getServerId()}:${last}`)).toHaveCount(0);
    await expect(
      page
        .getByTestId(`workspace-tree-node-${getServerId()}:${grandchild}`)
        .filter({ visible: true }),
    ).toBeVisible();
  } finally {
    await seeded.cleanup();
  }
});

test("a rejected drag stays visible and can be retried against the real daemon", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedWorkspace({ repoPrefix: "workspace-tree-retry-", title: "Parent" });
  try {
    const response = await seeded.client.createWorkspace({
      source: { kind: "directory", path: seeded.repoPath, projectId: seeded.projectId },
      title: "Move me",
    });
    if (!response.workspace) throw new Error(response.error ?? "Workspace creation failed");
    const movingId = response.workspace.id;
    let rejectNextMove = true;
    const moveMessage = z
      .object({
        type: z.literal("session"),
        message: z
          .object({
            type: z.literal("workspace.move.request"),
            workspaceId: z.string(),
            parentWorkspaceId: z.string().nullable(),
          })
          .passthrough(),
      })
      .passthrough();
    await page.routeWebSocket(new RegExp(`:${getE2EDaemonPort()}(?:/|$)`), (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const parsed = moveMessage.safeParse(JSON.parse(message.toString()));
        if (parsed.success && rejectNextMove) {
          rejectNextMove = false;
          // Exercise the real daemon's cycle refusal, then retry the original intent.
          server.send(
            JSON.stringify({
              ...parsed.data,
              message: {
                ...parsed.data.message,
                parentWorkspaceId: parsed.data.message.workspaceId,
              },
            }),
          );
        } else server.send(message);
      });
      server.onMessage((message) => socket.send(message));
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await dragWorkspace(page, movingId, seeded.workspaceId, "inside");
    const error = page.getByTestId("workspace-tree-move-error").filter({ visible: true });
    await expect(error).toBeVisible();
    await expect(error).toContainText("A workspace cannot be its own ancestor");
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(error).toHaveCount(0);
    await expect
      .poll(async () => {
        const snapshot = await seeded.client.fetchWorkspaces({
          filter: { projectId: seeded.projectId },
        });
        return snapshot.entries.find((entry) => entry.id === movingId)?.parentWorkspaceId;
      })
      .toBe(seeded.workspaceId);
  } finally {
    await seeded.cleanup();
  }
});

test("a workspace can be dragged through a scrolling sidebar into a parent", async ({ page }) => {
  test.setTimeout(120_000);
  const seeded = await seedWorkspace({
    repoPrefix: "workspace-tree-scroll-",
    title: "Parent at top",
  });
  try {
    let movingId = "";
    for (let index = 0; index < 30; index += 1) {
      const created = await seeded.client.createWorkspace({
        source: { kind: "directory", path: seeded.repoPath, projectId: seeded.projectId },
        title: `Workspace ${index}`,
      });
      if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
      movingId = created.workspace.id;
    }
    await page.setViewportSize({ width: 1200, height: 720 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const source = page
      .getByTestId(`workspace-tree-drag-${getServerId()}:${movingId}`)
      .filter({ visible: true })
      .first();
    const target = page
      .getByTestId(`workspace-tree-node-${getServerId()}:${seeded.workspaceId}`)
      .filter({ visible: true })
      .first();
    const scroll = page
      .getByTestId("sidebar-project-workspace-list-scroll")
      .filter({ visible: true })
      .first();
    await source.scrollIntoViewIfNeeded();
    const from = await visibleBoundingBox(source);
    const viewport = await visibleBoundingBox(scroll);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 2 });
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + 12, { steps: 12 });
    await expect(target).toBeInViewport({ timeout: 20_000 });
    const destination = await visibleBoundingBox(target);
    await page.mouse.move(
      destination.x + destination.width / 2,
      destination.y + destination.height / 2,
      { steps: 4 },
    );
    await expect(page.getByTestId("workspace-tree-drop-inside")).toBeVisible();
    await page.mouse.up();
    await expect
      .poll(async () => {
        const snapshot = await seeded.client.fetchWorkspaces({
          filter: { projectId: seeded.projectId },
        });
        return snapshot.entries.find((entry) => entry.id === movingId)?.parentWorkspaceId;
      })
      .toBe(seeded.workspaceId);
  } finally {
    await seeded.cleanup();
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

test("project sorts are independent, persist, and restore the dragged manual order", async ({
  page,
}) => {
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
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
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

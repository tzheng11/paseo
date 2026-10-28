import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addConnectedHostAndReload,
  openSidebarHostFilter,
  reloadPreservingHostRegistry,
  selectAllHostsFilter,
  toggleHostFilter,
} from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  closeSidebarDisplayPreferences,
  openSidebarDisplayPage,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";

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
  const source = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const target = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height * 0.9,
  };

  await page.mouse.move(source.x, source.y);
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
}

async function dragWithoutReordering(rows: Locator): Promise<void> {
  const before = await rowTestIds(rows);
  const source = await visibleBoundingBox(rows.nth(0));
  const target = await visibleBoundingBox(rows.nth(1));
  const page = rows.page();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => rowTestIds(rows)).toEqual(before);
}

test("projects and pinned chats reorder while ordinary workspaces stay newest first", async ({
  page,
}) => {
  const firstProject = await seedWorkspace({
    repoPrefix: "sidebar-reorder-first-",
  });
  const secondProject = await seedWorkspace({
    repoPrefix: "sidebar-reorder-second-",
  });

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

    const firstProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(
      firstProject.projectKey,
    )}`;
    const secondProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(
      secondProject.projectKey,
    )}`;
    await quickDragFirstRowAfterSecond(
      page.locator(`[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`),
      pressProjectRow,
    );
    const firstWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${
      firstProject.workspaceId
    }`;
    const secondWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${
      secondWorkspace.workspace.id
    }`;
    const ordinaryRows = page.locator(
      `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
    );
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );
    await expect
      .poll(() => rowTestIds(ordinaryRows))
      .toEqual([secondWorkspaceTestId, firstWorkspaceTestId]);
    await dragWithoutReordering(ordinaryRows);

    await firstProject.client.setWorkspacePinned(firstProject.workspaceId, true);
    await secondProject.client.setWorkspacePinned(secondProject.workspaceId, true);
    const secondProjectWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${
      secondProject.workspaceId
    }`;
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

type PinSection = "pinned" | "superpinned";

function pinSection(page: Page, section: PinSection = "pinned") {
  return page.getByTestId(`sidebar-${section}-section`).filter({ visible: true }).first();
}

function treeNode(page: Page, workspaceKey: string, section: PinSection = "pinned") {
  return pinSection(page, section).getByTestId(`workspace-tree-node-${workspaceKey}`);
}

async function treeIndent(
  page: Page,
  childKey: string,
  rootKey: string,
  section: PinSection = "pinned",
) {
  const child = await visibleBoundingBox(treeNode(page, childKey, section));
  const root = await visibleBoundingBox(treeNode(page, rootKey, section));
  return child.x - root.x;
}

async function expectTreeOrder(
  page: Page,
  workspaceKeys: string[],
  section: PinSection = "pinned",
) {
  const testIds = workspaceKeys.map((key) => `workspace-tree-node-${key}`);
  await expect
    .poll(async () => {
      const actual = await rowTestIds(
        pinSection(page, section).locator('[data-testid^="workspace-tree-node-"]'),
      );
      return actual.filter((id) => id !== null && testIds.includes(id));
    })
    .toEqual(testIds);
}

async function createWorkspace(
  seeded: SeededWorkspace,
  title: string,
  options: { workspaceId?: string; parentWorkspaceId?: string } = {},
) {
  // The real SDK accepts caller-selected IDs. Keeping the options variable also
  // lets this regression prove that identical IDs on two hosts stay independent.
  const input = {
    source: {
      kind: "directory" as const,
      path: seeded.repoPath,
      projectId: seeded.projectId,
    },
    title,
    ...options,
  };
  const response = await seeded.client.createWorkspace(input);
  if (!response.workspace) throw new Error(response.error ?? "Workspace creation failed");
  return response.workspace.id;
}

async function backendHierarchy(seeded: SeededWorkspace) {
  const snapshot = await seeded.client.fetchWorkspaces({
    filter: { projectId: seeded.projectId },
  });
  return snapshot.entries
    .map((workspace) => ({
      id: workspace.id,
      parentWorkspaceId: workspace.parentWorkspaceId ?? null,
      siblingOrder: workspace.siblingOrder,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function observeWorkspaceMoves(page: Page, ports = [getE2EDaemonPort()]) {
  const observed = { moves: [] as string[], connectedPorts: new Set<string>() };
  await page.routeWebSocket(new RegExp(`:(?:${ports.join("|")})\\b`), (browser) => {
    observed.connectedPorts.add(new URL(browser.url()).port);
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      const envelope = JSON.parse(raw);
      if (envelope.message?.type === "workspace.move.request") observed.moves.push(raw);
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  return observed;
}

function expectNoWorkspaceMoves(
  observed: Awaited<ReturnType<typeof observeWorkspaceMoves>>,
  ports = [getE2EDaemonPort()],
) {
  for (const port of ports) expect(observed.connectedPorts.has(port)).toBe(true);
  expect(observed.moves).toEqual([]);
}

async function beginWorkspaceDrag(
  page: Page,
  sourceKey: string,
  targetKey: string,
  position: "before" | "inside" | "after",
  wholeRow = false,
) {
  const source = page
    .getByTestId(`${wholeRow ? "sidebar-workspace-row" : "workspace-tree-drag"}-${sourceKey}`)
    .filter({ visible: true })
    .first();
  const target = page
    .getByTestId(`workspace-tree-node-${targetKey}`)
    .filter({ visible: true })
    .first();
  await source.scrollIntoViewIfNeeded();
  const from = await visibleBoundingBox(source);
  const to = await visibleBoundingBox(target);
  const fraction = { before: 0.1, inside: 0.5, after: 0.9 }[position];
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, {
    steps: 2,
  });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * fraction, {
    steps: 8,
  });
}

async function dragWorkspace(
  page: Page,
  sourceKey: string,
  targetKey: string,
  position: "before" | "inside" | "after",
) {
  await beginWorkspaceDrag(page, sourceKey, targetKey, position);
  await expect(page.getByTestId(`workspace-tree-drop-${position}`)).toBeVisible();
  await page.mouse.up();
}

async function rowMenuAction(page: Page, workspaceKey: string, action: "pin" | "superpin") {
  const row = page
    .getByTestId(`sidebar-workspace-row-${workspaceKey}`)
    .filter({ visible: true })
    .first();
  await row.hover();
  await page
    .getByTestId(`sidebar-workspace-kebab-${workspaceKey}`)
    .filter({ visible: true })
    .click();
  await page.getByTestId(`sidebar-workspace-menu-${action}-${workspaceKey}`).click();
}

test("pinned trees span hosts and projects, order siblings and subtrees, and survive reload while ordinary lists stay flat", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const secondary = await startIsolatedHostDaemon(
    `srv_tree_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  );
  const seededWorkspaces: SeededWorkspace[] = [];
  try {
    const primary = await seedWorkspace({
      repoPrefix: "pinned-tree-primary-",
      title: "Parent",
    });
    seededWorkspaces.push(primary);
    const remote = await seedWorkspace({
      repoPrefix: "pinned-tree-remote-",
      port: secondary.port,
    });
    seededWorkspaces.push(remote);
    const otherProject = await seedWorkspace({
      repoPrefix: "pinned-tree-other-",
      title: "Last child",
    });
    seededWorkspaces.push(otherProject);
    const remoteChild = await createWorkspace(remote, "First child on another host", {
      workspaceId: primary.workspaceId,
    });
    expect(remoteChild).toBe(primary.workspaceId);
    const between = await createWorkspace(remote, "Between children");
    const grandchild = await createWorkspace(primary, "Grandchild");
    const ordinaryParent = await createWorkspace(primary, "Ordinary parent");
    const ordinaryChild = await createWorkspace(primary, "Ordinary backend child", {
      parentWorkspaceId: ordinaryParent,
    });
    await primary.client.setWorkspacePinned(primary.workspaceId, true);
    await remote.client.setWorkspacePinned(remoteChild, true);
    await otherProject.client.setWorkspacePinned(otherProject.workspaceId, true);
    await remote.client.setWorkspacePinned(between, true);
    await primary.client.setWorkspacePinned(grandchild, true);
    const before = await Promise.all([
      backendHierarchy(primary),
      backendHierarchy(remote),
      backendHierarchy(otherProject),
    ]);
    const moves = await observeWorkspaceMoves(page, [getE2EDaemonPort(), String(secondary.port)]);
    const parentKey = `${getServerId()}:${primary.workspaceId}`;
    const firstKey = `${secondary.serverId}:${remoteChild}`;
    const betweenKey = `${secondary.serverId}:${between}`;
    const lastKey = `${getServerId()}:${otherProject.workspaceId}`;
    const grandchildKey = `${getServerId()}:${grandchild}`;
    await page.setViewportSize({ width: 1440, height: 1100 });
    await gotoAppShell(page);
    await addConnectedHostAndReload(page, {
      serverId: secondary.serverId,
      label: "Second tree host",
      port: secondary.port,
    });
    await expect(treeNode(page, firstKey)).toBeVisible();
    await dragWorkspace(page, firstKey, parentKey, "inside");
    await expect.poll(() => treeIndent(page, firstKey, parentKey)).toBe(16);
    await dragWorkspace(page, lastKey, parentKey, "inside");
    await dragWorkspace(page, betweenKey, lastKey, "before");
    await expectTreeOrder(page, [parentKey, firstKey, betweenKey, lastKey]);
    await expect.poll(() => treeIndent(page, betweenKey, parentKey)).toBe(16);
    await dragWorkspace(page, grandchildKey, lastKey, "inside");
    await expect.poll(() => treeIndent(page, grandchildKey, parentKey)).toBe(32);
    await dragWorkspace(page, lastKey, betweenKey, "inside");
    await expect.poll(() => treeIndent(page, lastKey, parentKey)).toBe(32);
    await expect.poll(() => treeIndent(page, grandchildKey, parentKey)).toBe(48);
    await dragWorkspace(page, lastKey, parentKey, "before");
    await expectTreeOrder(page, [lastKey, grandchildKey, parentKey, firstKey, betweenKey]);
    await expect.poll(() => treeIndent(page, grandchildKey, lastKey)).toBe(16);
    const toggle = pinSection(page).getByTestId(`workspace-tree-toggle-${lastKey}`);
    await toggle.click();
    await expect(treeNode(page, grandchildKey)).toHaveCount(0);
    await reloadPreservingHostRegistry(page);
    await expect(toggle).toBeVisible();
    await expect(treeNode(page, grandchildKey)).toHaveCount(0);
    await toggle.click();
    await expectTreeOrder(page, [lastKey, grandchildKey, parentKey, firstKey, betweenKey]);
    await expect.poll(() => treeIndent(page, firstKey, parentKey)).toBe(16);
    await expect.poll(() => treeIndent(page, grandchildKey, lastKey)).toBe(16);
    await selectSidebarStatusGrouping(page);
    await expectTreeOrder(page, [lastKey, grandchildKey, parentKey, firstKey, betweenKey]);
    await expect.poll(() => treeIndent(page, firstKey, parentKey)).toBe(16);
    await expect.poll(() => treeIndent(page, grandchildKey, lastKey)).toBe(16);
    const crossHostToggle = pinSection(page).getByTestId(`workspace-tree-toggle-${parentKey}`);
    await crossHostToggle.click();
    await expect(treeNode(page, firstKey)).toHaveCount(0);
    await expect(treeNode(page, parentKey)).toBeVisible();
    await expect(treeNode(page, grandchildKey)).toBeVisible();
    await reloadPreservingHostRegistry(page);
    await expect(crossHostToggle).toBeVisible();
    await expect(treeNode(page, firstKey)).toHaveCount(0);
    await crossHostToggle.click();
    await expect.poll(() => treeIndent(page, firstKey, parentKey)).toBe(16);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-project").click();
    // Backend hierarchy is deliberately present here, but project rows stay flat.
    const ordinaryParentRow = page
      .getByTestId(`sidebar-workspace-row-${getServerId()}:${ordinaryParent}`)
      .filter({ visible: true });
    const ordinaryChildRow = page
      .getByTestId(`sidebar-workspace-row-${getServerId()}:${ordinaryChild}`)
      .filter({ visible: true });
    await expect(ordinaryParentRow).toBeVisible();
    await expect(ordinaryChildRow).toBeVisible();
    expect((await visibleBoundingBox(ordinaryChildRow)).x).toBe(
      (await visibleBoundingBox(ordinaryParentRow)).x,
    );
    await expect(
      page.getByTestId(`workspace-tree-toggle-${getServerId()}:${ordinaryParent}`),
    ).toHaveCount(0);
    expect(
      await Promise.all([
        backendHierarchy(primary),
        backendHierarchy(remote),
        backendHierarchy(otherProject),
      ]),
    ).toEqual(before);
    expectNoWorkspaceMoves(moves, [getE2EDaemonPort(), String(secondary.port)]);
    await page.mouse.move(1000, 900);
    await page.screenshot({
      path: testInfo.outputPath("pinned-cross-host-hierarchy.png"),
      animations: "disabled",
    });
  } finally {
    await Promise.allSettled(seededWorkspaces.map((seeded) => seeded.cleanup()));
    await secondary.close();
  }
});

test("pinned nesting names its cross-project target, confirms local persistence, and explains cycle refusal", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const parent = await seedWorkspace({
    repoPrefix: "pinned-tree-feedback-",
    title: "Parent",
  });
  const child = await seedWorkspace({
    repoPrefix: "pinned-tree-feedback-child-",
    title: "Child",
  });
  try {
    await parent.client.setWorkspacePinned(parent.workspaceId, true);
    await child.client.setWorkspacePinned(child.workspaceId, true);
    const before = await Promise.all([backendHierarchy(parent), backendHierarchy(child)]);
    const moves = await observeWorkspaceMoves(page);
    const parentKey = `${getServerId()}:${parent.workspaceId}`;
    const childKey = `${getServerId()}:${child.workspaceId}`;
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await beginWorkspaceDrag(page, childKey, parentKey, "inside", true);
    await expect(page.getByTestId("workspace-tree-drop-inside")).toContainText(
      "Nest under “Parent”",
    );
    await expect(page.getByTestId("workspace-tree-drag-feedback")).toHaveText(
      "Nest under “Parent”",
    );
    await page.screenshot({
      path: testInfo.outputPath("pinned-nesting-target.png"),
      animations: "disabled",
    });
    await page.mouse.up();
    await expect(page.getByTestId("workspace-tree-move-success")).toContainText(
      "Nested “Child” under “Parent”",
    );
    await expect.poll(() => treeIndent(page, childKey, parentKey)).toBe(16);
    await page.mouse.move(1200, 900);
    await page.screenshot({
      path: testInfo.outputPath("pinned-nesting-confirmed.png"),
      animations: "disabled",
    });
    await reloadPreservingHostRegistry(page);
    await expect.poll(() => treeIndent(page, childKey, parentKey)).toBe(16);
    await beginWorkspaceDrag(page, parentKey, childKey, "inside", true);
    const message = "A workspace cannot be moved into one of its children";
    const blocked = page.getByTestId("workspace-tree-drop-blocked");
    const reason = blocked.getByText(message, { exact: true });
    await expect(reason).toBeVisible();
    const overlayBounds = await visibleBoundingBox(blocked);
    const reasonBounds = await visibleBoundingBox(reason);
    expect(reasonBounds.y).toBeGreaterThanOrEqual(overlayBounds.y);
    expect(reasonBounds.y + reasonBounds.height).toBeLessThanOrEqual(
      overlayBounds.y + overlayBounds.height,
    );
    const previewReason = page.getByTestId("workspace-tree-drag-feedback");
    await expect(previewReason).toHaveText(message);
    const previewBounds = await visibleBoundingBox(page.getByTestId("workspace-tree-drag-preview"));
    const feedbackBounds = await visibleBoundingBox(previewReason);
    expect(feedbackBounds.y).toBeGreaterThanOrEqual(previewBounds.y);
    expect(feedbackBounds.y + feedbackBounds.height).toBeLessThanOrEqual(
      previewBounds.y + previewBounds.height,
    );
    await page.screenshot({
      path: testInfo.outputPath("pinned-nesting-cycle-blocked.png"),
      animations: "disabled",
    });
    await page.mouse.up();
    await expect(page.getByTestId("workspace-tree-move-blocked")).toContainText(message);
    await expect(page.getByTestId("workspace-tree-move-error")).toHaveCount(0);
    await expect.poll(() => treeIndent(page, childKey, parentKey)).toBe(16);
    expect(await Promise.all([backendHierarchy(parent), backendHierarchy(child)])).toEqual(before);
    expectNoWorkspaceMoves(moves);
  } finally {
    await Promise.allSettled([parent.cleanup(), child.cleanup()]);
  }
});

test("keyboard pinned dragging uses full host keys to reorder, nest Right, and lift Left", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const secondary = await startIsolatedHostDaemon(
    `srv_keys_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  );
  const seededWorkspaces: SeededWorkspace[] = [];
  try {
    const first = await seedWorkspace({
      repoPrefix: "pinned-keyboard-first-",
      title: "First",
    });
    seededWorkspaces.push(first);
    const remote = await seedWorkspace({
      repoPrefix: "pinned-keyboard-second-",
      port: secondary.port,
    });
    seededWorkspaces.push(remote);
    const secondId = await createWorkspace(remote, "Second", {
      workspaceId: first.workspaceId,
    });
    await remote.client.setWorkspacePinned(secondId, true);
    await first.client.setWorkspacePinned(first.workspaceId, true);
    const before = await Promise.all([backendHierarchy(first), backendHierarchy(remote)]);
    const moves = await observeWorkspaceMoves(page, [getE2EDaemonPort(), String(secondary.port)]);
    const firstKey = `${getServerId()}:${first.workspaceId}`;
    const secondKey = `${secondary.serverId}:${secondId}`;
    const handle = () => pinSection(page).getByTestId(`workspace-tree-drag-${firstKey}`);
    await gotoAppShell(page);
    await addConnectedHostAndReload(page, {
      serverId: secondary.serverId,
      label: "Keyboard second host",
      port: secondary.port,
    });
    await expect(treeNode(page, firstKey)).toBeVisible();
    await expect(treeNode(page, secondKey)).toBeVisible();
    await dragWorkspace(page, firstKey, secondKey, "before");
    await expectTreeOrder(page, [firstKey, secondKey]);
    await handle().focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("workspace-tree-drop-after")).toBeVisible();
    await page.keyboard.press("Space");
    await expectTreeOrder(page, [secondKey, firstKey]);
    await expect.poll(() => treeIndent(page, firstKey, secondKey)).toBe(0);
    await handle().focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("workspace-tree-drop-inside")).toBeVisible();
    await page.keyboard.press("Space");
    await expect.poll(() => treeIndent(page, firstKey, secondKey)).toBe(16);
    await reloadPreservingHostRegistry(page);
    await expect.poll(() => treeIndent(page, firstKey, secondKey)).toBe(16);
    await handle().focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("workspace-tree-drop-after")).toBeVisible();
    await page.keyboard.press("Space");
    await expectTreeOrder(page, [secondKey, firstKey]);
    await expect.poll(() => treeIndent(page, firstKey, secondKey)).toBe(0);
    expect(await Promise.all([backendHierarchy(first), backendHierarchy(remote)])).toEqual(before);
    expectNoWorkspaceMoves(moves, [getE2EDaemonPort(), String(secondary.port)]);
  } finally {
    await Promise.allSettled(seededWorkspaces.map((seeded) => seeded.cleanup()));
    await secondary.close();
  }
});

test("cross-section leaves wait for their source host pin ACK, retry refusals, and guard subtrees", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const secondary = await startIsolatedHostDaemon(
    `srv_pins_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  );
  const seededWorkspaces: SeededWorkspace[] = [];
  const held = { release: null as (() => void) | null };
  let tearingDown = false;
  try {
    const target = await seedWorkspace({
      repoPrefix: "pinned-section-target-",
      title: "SuperPinned parent",
    });
    seededWorkspaces.push(target);
    const remote = await seedWorkspace({
      repoPrefix: "pinned-section-source-",
      title: "Remote mover",
      port: secondary.port,
    });
    seededWorkspaces.push(remote);
    const landing = await createWorkspace(remote, "Pinned landing");
    const child = await createWorkspace(target, "Child on first host");
    const remoteSuperpinned = await createWorkspace(remote, "Remote SuperPinned anchor");
    await target.client.setWorkspaceSuperpinned(target.workspaceId, true);
    await remote.client.setWorkspacePinned(remote.workspaceId, true);
    await remote.client.setWorkspacePinned(landing, true);
    await target.client.setWorkspacePinned(child, true);
    await remote.client.setWorkspaceSuperpinned(remoteSuperpinned, true);
    const before = await Promise.all([backendHierarchy(target), backendHierarchy(remote)]);
    const targetKey = `${getServerId()}:${target.workspaceId}`;
    const movingKey = `${secondary.serverId}:${remote.workspaceId}`;
    const landingKey = `${secondary.serverId}:${landing}`;
    const childKey = `${getServerId()}:${child}`;
    const remoteSuperpinnedKey = `${secondary.serverId}:${remoteSuperpinned}`;
    const moves: string[] = [];
    const pinRequests: string[] = [];
    let rejectFirst = true;
    let heldAcceptedResponse = false;
    const request = z
      .object({
        message: z.object({ type: z.string(), workspaceId: z.string().optional() }).passthrough(),
      })
      .passthrough();
    await page.routeWebSocket(
      new RegExp(`:(?:${getE2EDaemonPort()}|${secondary.port})\\b`),
      (browser) => {
        if (tearingDown) return;
        const sourceHost = new URL(browser.url()).port === String(secondary.port);
        const server = browser.connectToServer();
        const buffered: Array<string | Buffer> = [];
        let gate = false;
        browser.onMessage((message) => {
          const parsed = request.safeParse(JSON.parse(message.toString()));
          if (parsed.success && parsed.data.message.type === "workspace.move.request")
            moves.push(message.toString());
          if (parsed.success && parsed.data.message.type === "workspace.pin.set.request")
            pinRequests.push(sourceHost ? "source" : "target");
          if (parsed.success && parsed.data.message.type === "workspace.superpin.set.request") {
            pinRequests.push(sourceHost ? "source" : "target");
            if (sourceHost && rejectFirst) {
              rejectFirst = false;
              // A real source-host refusal, followed by a retry of the unchanged UI intent.
              server.send(
                JSON.stringify({
                  ...parsed.data,
                  message: {
                    ...parsed.data.message,
                    workspaceId: "wks_0000000000000000",
                  },
                }),
              );
              return;
            }
            // Registry subscriptions can publish the confirmed pin before its
            // RPC response. Gate from request admission, rather than from ACK.
            if (sourceHost && !heldAcceptedResponse) gate = true;
          }
          server.send(message);
        });
        server.onMessage((message) => {
          const envelope = JSON.parse(message.toString());
          if (
            sourceHost &&
            !heldAcceptedResponse &&
            envelope.message?.type === "workspace.superpin.set.response" &&
            envelope.message.payload.accepted
          ) {
            heldAcceptedResponse = true;
            gate = true;
            held.release = () => {
              held.release = null;
              gate = false;
              for (const frame of buffered.splice(0)) browser.send(frame);
            };
          }
          if (gate) buffered.push(message);
          else browser.send(message);
        });
      },
    );
    await gotoAppShell(page);
    await addConnectedHostAndReload(page, {
      serverId: secondary.serverId,
      label: "Pin owner host",
      port: secondary.port,
    });
    await dragWorkspace(page, movingKey, targetKey, "inside");
    const error = page.getByTestId("workspace-tree-move-error").filter({ visible: true });
    await expect(error).toContainText("Workspace not found");
    await expect(treeNode(page, movingKey)).toBeVisible();
    await expect(treeNode(page, movingKey, "superpinned")).toHaveCount(0);
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => held.release !== null).toBe(true);
    await expect(page.getByTestId("workspace-tree-move-pending")).toBeVisible();
    await expect(page.getByTestId("workspace-tree-move-success")).toHaveCount(0);
    await expect(treeNode(page, movingKey)).toBeVisible();
    await expect(treeNode(page, movingKey, "superpinned")).toHaveCount(0);
    const sourceState = (await remote.client.fetchWorkspaces()).entries.find(
      (workspace) => workspace.id === remote.workspaceId,
    );
    expect(sourceState?.superpinnedAt).toBeTruthy();
    held.release?.();
    await expect(page.getByTestId("workspace-tree-move-success")).toContainText(
      "Nested “Remote mover” under “SuperPinned parent”",
    );
    await expect.poll(() => treeIndent(page, movingKey, targetKey, "superpinned")).toBe(16);
    await expect(treeNode(page, movingKey)).toHaveCount(0);
    expect(pinRequests).toEqual(["source", "source"]);
    await dragWorkspace(page, movingKey, landingKey, "inside");
    await expect.poll(() => treeIndent(page, movingKey, landingKey)).toBe(16);
    await expect(treeNode(page, movingKey, "superpinned")).toHaveCount(0);
    await dragWorkspace(page, childKey, movingKey, "inside");
    await expect.poll(() => treeIndent(page, childKey, landingKey)).toBe(32);
    const requestsBeforeGuard = pinRequests.length;
    await beginWorkspaceDrag(page, movingKey, targetKey, "inside");
    const blocked = "Move children out first before moving this workspace to another pin section";
    await expect(page.getByTestId("workspace-tree-drop-blocked")).toContainText(blocked);
    await page.mouse.up();
    await expect(page.getByTestId("workspace-tree-move-blocked")).toContainText(blocked);
    expect(pinRequests).toHaveLength(requestsBeforeGuard);
    await expect.poll(() => treeIndent(page, childKey, landingKey)).toBe(32);
    await openSidebarHostFilter(page);
    await toggleHostFilter(page, secondary.serverId);
    await closeSidebarDisplayPreferences(page);
    await expect(treeNode(page, childKey)).toHaveCount(0);
    await expect(treeNode(page, movingKey)).toBeVisible();
    await beginWorkspaceDrag(page, movingKey, remoteSuperpinnedKey, "inside");
    await expect(page.getByTestId("workspace-tree-drop-blocked")).toContainText(blocked);
    await page.mouse.up();
    await expect(page.getByTestId("workspace-tree-move-blocked")).toContainText(blocked);
    expect(pinRequests).toHaveLength(requestsBeforeGuard);
    await openSidebarHostFilter(page);
    await selectAllHostsFilter(page);
    await closeSidebarDisplayPreferences(page);
    await expect.poll(() => treeIndent(page, childKey, landingKey)).toBe(32);
    // Menu changes can move one parent: its children become roots while their
    // saved edges remain dormant, then reappear when the parent returns.
    await rowMenuAction(page, movingKey, "superpin");
    await expect(treeNode(page, movingKey, "superpinned")).toBeVisible();
    await expect.poll(() => treeIndent(page, childKey, landingKey)).toBe(0);
    await rowMenuAction(page, movingKey, "superpin");
    await expect.poll(() => treeIndent(page, movingKey, landingKey)).toBe(16);
    await expect.poll(() => treeIndent(page, childKey, landingKey)).toBe(32);
    await rowMenuAction(page, movingKey, "pin");
    await expect(treeNode(page, movingKey)).toHaveCount(0);
    await expect.poll(() => treeIndent(page, childKey, landingKey)).toBe(0);
    await rowMenuAction(page, movingKey, "pin");
    await expect.poll(() => treeIndent(page, movingKey, landingKey)).toBe(16);
    await expect.poll(() => treeIndent(page, childKey, landingKey)).toBe(32);
    await reloadPreservingHostRegistry(page);
    await expect.poll(() => treeIndent(page, childKey, landingKey)).toBe(32);
    expect(pinRequests.every((host) => host === "source")).toBe(true);
    expect(await Promise.all([backendHierarchy(target), backendHierarchy(remote)])).toEqual(before);
    expect(moves).toEqual([]);
  } finally {
    tearingDown = true;
    held.release?.();
    await Promise.allSettled(seededWorkspaces.map((seeded) => seeded.cleanup()));
    await secondary.close();
  }
});

test("a pinned workspace can be dragged through a scrolling sidebar into a parent", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedWorkspace({
    repoPrefix: "pinned-tree-scroll-",
    title: "Parent at top",
  });
  try {
    const ids = [seeded.workspaceId];
    let movingId = "";
    for (let index = 0; index < 30; index += 1) {
      movingId = await createWorkspace(seeded, `Workspace ${index}`);
      ids.push(movingId);
    }
    // Newer pins sort first; pin in reverse so the parent is above the scroll.
    for (const id of ids.toReversed()) await seeded.client.setWorkspacePinned(id, true);
    const before = await backendHierarchy(seeded);
    const moves = await observeWorkspaceMoves(page);
    const movingKey = `${getServerId()}:${movingId}`;
    const parentKey = `${getServerId()}:${seeded.workspaceId}`;
    await page.setViewportSize({ width: 1200, height: 720 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const source = pinSection(page).getByTestId(`workspace-tree-drag-${movingKey}`);
    const target = treeNode(page, parentKey);
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
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + 12, {
      steps: 12,
    });
    await expect(target).toBeInViewport({ timeout: 20_000 });
    const destination = await visibleBoundingBox(target);
    await page.mouse.move(
      destination.x + destination.width / 2,
      destination.y + destination.height / 2,
      { steps: 4 },
    );
    await expect(page.getByTestId("workspace-tree-drop-inside")).toBeVisible();
    await page.mouse.up();
    await expect.poll(() => treeIndent(page, movingKey, parentKey)).toBe(16);
    expect(await backendHierarchy(seeded)).toEqual(before);
    expectNoWorkspaceMoves(moves);
  } finally {
    await seeded.cleanup();
  }
});

test("pinned A–Z sorting yields to a persisted three-row drag and follows renames", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const zeta = await seedWorkspace({ title: "Zeta pinned", repoPrefix: "pinned-sort-zeta-" });
  const alpha = await seedWorkspace({ title: "Alpha pinned", repoPrefix: "pinned-sort-alpha-" });
  try {
    const beta = await createWorkspace(alpha, "Beta pinned");
    await alpha.client.setWorkspacePinned(alpha.workspaceId, true);
    await alpha.client.setWorkspacePinned(beta, true);
    await zeta.client.setWorkspacePinned(zeta.workspaceId, true);
    const moves = await observeWorkspaceMoves(page);
    const zetaKey = `${getServerId()}:${zeta.workspaceId}`;
    const alphaKey = `${getServerId()}:${alpha.workspaceId}`;
    const betaKey = `${getServerId()}:${beta}`;
    await page.setViewportSize({ width: 1440, height: 1200 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const section = pinSection(page);
    const alphaRow = section.getByTestId(`sidebar-workspace-row-${alphaKey}`);
    const sort = section.getByTestId("sidebar-pinned-sort");
    await expectTreeOrder(page, [zetaKey, betaKey, alphaKey]);
    await sort.click();
    await page.getByTestId("sidebar-pinned-sort-alphabetical").click();
    await expectTreeOrder(page, [alphaKey, betaKey, zetaKey]);
    await expect(sort).toContainText("A–Z");
    await reloadPreservingHostRegistry(page);
    await expect(sort).toContainText("A–Z");
    await expectTreeOrder(page, [alphaKey, betaKey, zetaKey]);
    // The third row makes a rank-vs-visible-order mixup observable: a drag from
    // alphabetical order must preserve the two untouched visible siblings.
    await dragWorkspace(page, zetaKey, alphaKey, "before");
    await expect(sort).toContainText("Manual");
    await expectTreeOrder(page, [zetaKey, alphaKey, betaKey]);
    await reloadPreservingHostRegistry(page);
    await expect(sort).toContainText("Manual");
    await expectTreeOrder(page, [zetaKey, alphaKey, betaKey]);
    await sort.click();
    await page.getByTestId("sidebar-pinned-sort-alphabetical").click();
    await alpha.client.setWorkspaceTitle(alpha.workspaceId, "Zulu renamed");
    await expect(alphaRow).toContainText("Zulu renamed");
    await expectTreeOrder(page, [betaKey, zetaKey, alphaKey]);
    await sort.click();
    await page.getByTestId("sidebar-pinned-sort-manual").click();
    await expectTreeOrder(page, [zetaKey, alphaKey, betaKey]);
    expectNoWorkspaceMoves(moves);
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
      source: {
        kind: "directory",
        path: first.repoPath,
        projectId: first.projectId,
      },
      title: "Alpha project workspace",
    });
    const secondAlpha = await second.client.createWorkspace({
      source: {
        kind: "directory",
        path: second.repoPath,
        projectId: second.projectId,
      },
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
      `[data-testid="sidebar-workspace-row-${getServerId()}:${
        second.workspaceId
      }"], [data-testid="sidebar-workspace-row-${getServerId()}:${secondAlpha.workspace.id}"]`,
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
      source: {
        kind: "directory",
        path: project.repoPath,
        projectId: project.projectId,
      },
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
      source: {
        kind: "directory",
        path: project.repoPath,
        projectId: project.projectId,
      },
      title: "Z · most recent workspace",
    });
    const middle = await project.client.createWorkspace({
      source: {
        kind: "directory",
        path: project.repoPath,
        projectId: project.projectId,
      },
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
    await page.screenshot({
      path: testInfo.outputPath("last-activity-visible-age-order.png"),
    });
  } finally {
    await project.cleanup();
  }
});

async function selectWorkspaceSort(page: Page, name: "Manual" | "Created" | "Last prompt") {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await page.getByRole("menuitem", { name: /^Sort/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function reconnectSidebar(page: Page): Promise<void> {
  await page.reload();
  await waitForSidebarHydration(page);
}

async function expectNoWorkspaceSortChoice(page: Page): Promise<void> {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Sort/ })).toHaveCount(0);
}

async function promptWorkspace(seed: Awaited<ReturnType<typeof seedWorkspace>>, agentId: string) {
  await seed.client.sendAgentMessage(agentId, "sidebar ordering check");
  expect((await seed.client.waitForFinish(agentId, 30_000)).status).toBe("idle");
}

test("Created stays stable, Last prompt follows human submissions and survives tab archive", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = await seedWorkspace({ repoPrefix: "sidebar-sort-" });
  try {
    const newer = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "Newer workspace",
    });
    if (!newer.workspace) throw new Error(newer.error ?? "Workspace creation failed");
    const agent = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: seed.workspaceId,
      modeId: "load-test",
      model: "e2e-fast-stream",
      title: "Ordering agent",
    });
    const newerAgent = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: newer.workspace.id,
      modeId: "load-test",
      model: "e2e-fast-stream",
      title: "Newer agent",
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const oldId = `sidebar-workspace-row-${getServerId()}:${seed.workspaceId}`;
    const newId = `sidebar-workspace-row-${getServerId()}:${newer.workspace.id}`;
    const rows = page.locator(`[data-testid="${oldId}"], [data-testid="${newId}"]`);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await promptWorkspace(seed, agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await selectWorkspaceSort(page, "Last prompt");
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await promptWorkspace(seed, newerAgent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await promptWorkspace(seed, agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await seed.client.archiveAgent(agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await reconnectSidebar(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await selectSidebarStatusGrouping(page);
    await expectNoWorkspaceSortChoice(page);
  } finally {
    await seed.cleanup();
  }
});

async function seedCompactProject() {
  const seed = await seedWorkspace({
    repoPrefix: "sidebar-visibility-",
    title: "Oldest workspace",
  });
  const ids = [seed.workspaceId];
  for (let index = 2; index <= 12; index += 1) {
    const created = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: `Workspace ${index}`,
    });
    if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
    ids.unshift(created.workspace.id);
  }
  const agent = await seed.client.createAgent({
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
    cwd: seed.repoPath,
    workspaceId: seed.workspaceId,
    title: "Overflow agent",
  });
  return { seed, ids, agent };
}

async function expectWorkspaceOrder(rows: Locator, ids: string[]) {
  await expect
    .poll(() => rowTestIds(rows))
    .toEqual(ids.map((id) => `sidebar-workspace-row-${getServerId()}:${id}`));
}

async function revealWorkspaces(list: Locator, action: "Show more" | "Show less") {
  await list.getByLabel(action, { exact: true }).click();
}

async function selectProjectGrouping(page: Page) {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await page.getByRole("menuitem", { name: /^Group/ }).click();
  await page.getByTestId("sidebar-grouping-project").click();
}

type CompactProject = Awaited<ReturnType<typeof seedCompactProject>>;

function compactProjectRows(page: Page, seed: CompactProject["seed"]) {
  const list = page.getByTestId(`sidebar-workspace-list-${seed.projectKey}`);
  return {
    rows: list.locator('[data-testid^="sidebar-workspace-row-"]'),
    group: list.locator(".."),
    project: page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(seed.projectKey)}`),
  };
}

async function expectActiveOverflowTransitions(page: Page, { seed, ids, agent }: CompactProject) {
  const { rows } = compactProjectRows(page, seed);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));

  await seed.client.sendAgentMessage(agent.id, "show active overflow");
  await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[11]]);
  await seed.client.waitForFinish(agent.id, 15_000);
  await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[11]]);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

async function expectRevealSurvivesSortingAndCollapse(
  page: Page,
  { seed, ids, agent }: CompactProject,
) {
  const { rows, group, project } = compactProjectRows(page, seed);
  const retainedRows = await rows.elementHandles();
  await revealWorkspaces(group, "Show more");
  await expectWorkspaceOrder(rows, ids);
  for (const [index, retained] of retainedRows.entries()) {
    expect(
      await rows.nth(index).evaluate((current, previous) => current === previous, retained),
    ).toBe(true);
  }
  await project.click();
  await expect(rows).toHaveCount(0);
  await project.click();
  await expectWorkspaceOrder(rows, ids);
  await seed.client.sendAgentMessage(agent.id, "expanded overflow");
  await seed.client.waitForFinish(agent.id, 15_000);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expectWorkspaceOrder(rows, ids);
  await selectWorkspaceSort(page, "Last prompt");
  await expectWorkspaceOrder(rows, [ids[11], ...ids.slice(0, 11)]);
  const revealedRow = await rows.nth(8).elementHandle();
  await revealWorkspaces(group, "Show less");
  await expectWorkspaceOrder(rows, [ids[11], ...ids.slice(0, 6)]);
  await selectWorkspaceSort(page, "Created");
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
  expect(await revealedRow!.evaluate((row) => row.isConnected)).toBe(false);
  await reconnectSidebar(page);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

async function expectStatusBucketsRetainActiveOverflow(
  page: Page,
  { seed, ids, agent }: CompactProject,
) {
  const { rows } = compactProjectRows(page, seed);
  await selectSidebarStatusGrouping(page);
  const done = page.getByTestId("sidebar-status-group-rows-done");
  const doneRows = done.locator('[data-testid^="sidebar-workspace-row-"]');
  await expect(doneRows).toHaveCount(7);
  await revealWorkspaces(done, "Show more");
  await expect(doneRows).toHaveCount(12);
  await seed.client.sendAgentMessage(agent.id, "status overflow");
  await seed.client.waitForFinish(agent.id, 15_000);
  await expect(
    page
      .getByTestId("sidebar-status-group-rows-attention")
      .getByText("Oldest workspace", { exact: true }),
  ).toBeVisible();
  await expect(doneRows).toHaveCount(11);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expect(doneRows).toHaveCount(12);
  await revealWorkspaces(done, "Show less");
  await expect(doneRows).toHaveCount(7);
  const activeAgents: Array<{ id: string }> = [];
  for (const workspaceId of ids.slice(0, 8)) {
    activeAgents.push(
      await seed.client.createAgent({
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
        cwd: seed.repoPath,
        workspaceId,
        title: "Active overflow agent",
      }),
    );
  }
  await Promise.all(
    activeAgents.map((item) => seed.client.sendAgentMessage(item.id, "active bucket")),
  );
  await Promise.all(activeAgents.map((item) => seed.client.waitForFinish(item.id, 15_000)));
  const attention = page.getByTestId("sidebar-status-group-rows-attention");
  await expect(attention.locator('[data-testid^="sidebar-workspace-row-"]')).toHaveCount(8);
  await expect(attention.getByLabel("Show more", { exact: true })).toHaveCount(0);
  for (const workspaceId of ids.slice(0, 8)) await seed.client.clearWorkspaceAttention(workspaceId);
  await expect(doneRows).toHaveCount(7);
  await selectProjectGrouping(page);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

test("compact groups retain active overflow and reveal the current ordered rows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await seedCompactProject();
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await test.step("Active overflow appears without intervening Done rows", () =>
      expectActiveOverflowTransitions(page, fixture));
    await test.step("Reveal follows current sort and survives collapse", () =>
      expectRevealSurvivesSortingAndCollapse(page, fixture));
    await test.step("Status reveals Done rows and keeps every active row", () =>
      expectStatusBucketsRetainActiveOverflow(page, fixture));
  } finally {
    await fixture.seed.cleanup();
  }
});

async function restorePreBetaOrder(page: Page, projectKey: string, workspaceKeys: string[]) {
  await page.evaluate(
    ({ projectKey: scope, workspaceKeys: order }) => {
      localStorage.setItem(
        "sidebar-project-workspace-order",
        JSON.stringify({
          version: 1,
          state: {
            projectOrder: [scope],
            pinnedWorkspaceOrder: [],
            workspaceOrderByProject: { [scope]: order },
          },
        }),
      );
    },
    { projectKey, workspaceKeys },
  );
  await reconnectSidebar(page);
}

test("Manual restores pre-beta order and keeps drag order across sorting and reloads", async ({
  page,
}) => {
  const seed = await seedWorkspace({ repoPrefix: "sidebar-manual-" });
  try {
    const second = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "New manual workspace",
    });
    if (!second.workspace) throw new Error(second.error ?? "Workspace creation failed");
    const keys = [seed.workspaceId, second.workspace.id].map((id) => `${getServerId()}:${id}`);
    const ids = keys.map((key) => `sidebar-workspace-row-${key}`);
    const rows = page.locator(ids.map((id) => `[data-testid="${id}"]`).join(", "));
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await restorePreBetaOrder(page, projectEquivalenceViewKey(seed.projectKey), keys);
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await selectWorkspaceSort(page, "Last prompt");
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await reconnectSidebar(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await selectWorkspaceSort(page, "Created");
    await reconnectSidebar(page);
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
  } finally {
    await seed.cleanup();
  }
});

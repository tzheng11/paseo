import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

interface HierarchyWorkspace {
  id: string;
  parentWorkspaceId?: string | null;
  siblingOrder?: number;
}

interface HierarchyClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchWorkspaces(options: { filter: { projectId: string } }): Promise<{
    entries: HierarchyWorkspace[];
  }>;
  moveWorkspace(input: {
    workspaceId: string;
    parentWorkspaceId: string | null;
    beforeWorkspaceId?: string;
  }): Promise<unknown>;
}

function projectList(page: Page, project: SeededWorkspace) {
  return page.getByTestId(
    `sidebar-workspace-list-${projectEquivalenceViewKey(project.projectKey)}`,
  );
}

function treeRow(list: Locator, workspaceId: string) {
  return list.getByTestId(`sidebar-workspace-tree-row-${getServerId()}:${workspaceId}`);
}

function workspaceRow(list: Locator, workspaceId: string) {
  return list.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

async function createWorkspace(project: SeededWorkspace, title: string) {
  const result = await project.client.createWorkspace({
    source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
    title,
  });
  if (!result.workspace) throw new Error(result.error ?? `Could not create ${title}`);
  return result.workspace.id;
}

async function readWorkspace(
  client: HierarchyClient,
  project: SeededWorkspace,
  workspaceId: string,
) {
  return (await client.fetchWorkspaces({ filter: { projectId: project.projectId } })).entries.find(
    (workspace) => workspace.id === workspaceId,
  );
}

async function dragWorkspace(
  list: Locator,
  sourceId: string,
  targetId: string,
  position: "before" | "child" | "after",
  horizontalOffset = 0,
) {
  const source = workspaceRow(list, sourceId);
  const target = workspaceRow(list, targetId);
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Expected visible workspace drag targets");
  const sourcePoint = {
    x: sourceBox.x + Math.min(100, sourceBox.width / 2),
    y: sourceBox.y + sourceBox.height / 2,
  };
  const targetPoint = {
    x: targetBox.x + Math.min(100, targetBox.width / 2) + horizontalOffset,
    y: targetBox.y + targetBox.height * { before: 0.12, child: 0.5, after: 0.88 }[position],
  };
  const page = list.page();
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x, sourcePoint.y + 8, { steps: 2 });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
  await expect(treeRow(list, targetId)).toHaveAttribute(
    "data-drop-position",
    position === "child" ? "inside" : position,
  );
  await page.mouse.up();
  await expect(page.getByTestId("workspace-tree-move-pending")).toHaveCount(0);
  await expect(page.getByTestId("workspace-tree-move-error")).toHaveCount(0);
}

async function visibleWorkspaceIds(list: Locator) {
  return list
    .locator('[data-testid^="sidebar-workspace-tree-row-"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid")?.split(":").at(-1)),
    );
}

test("dragging nests workspaces, orders siblings with fractional positions, and survives reload", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({ repoPrefix: "workspace-tree-order-", title: "Parent" });
  const client = await connectDaemonClient<HierarchyClient>({ clientIdPrefix: "hierarchy-read" });
  try {
    const first = await createWorkspace(project, "First child");
    const second = await createWorkspace(project, "Second child");
    const third = await createWorkspace(project, "Third child");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const list = projectList(page, project);

    for (const id of [first, second, third]) {
      await dragWorkspace(list, id, project.workspaceId, "child");
      await expect
        .poll(async () => (await readWorkspace(client, project, id))?.parentWorkspaceId)
        .toBe(project.workspaceId);
      await expect(treeRow(list, id)).toHaveAttribute("data-depth", "1");
    }
    await expect
      .poll(() => visibleWorkspaceIds(list))
      .toEqual([project.workspaceId, first, second, third]);
    const firstBefore = await readWorkspace(client, project, first);
    const secondBefore = await readWorkspace(client, project, second);
    if (firstBefore?.siblingOrder === undefined || secondBefore?.siblingOrder === undefined)
      throw new Error("Expected persisted sibling positions");

    await dragWorkspace(list, third, second, "before");
    await expect
      .poll(async () => (await readWorkspace(client, project, third))?.siblingOrder)
      .toBe((firstBefore.siblingOrder + secondBefore.siblingOrder) / 2);
    await expect
      .poll(() => visibleWorkspaceIds(list))
      .toEqual([project.workspaceId, first, third, second]);

    await dragWorkspace(list, second, first, "before");
    await expect
      .poll(() => visibleWorkspaceIds(list))
      .toEqual([project.workspaceId, second, first, third]);
    await dragWorkspace(list, second, third, "after");
    await expect
      .poll(() => visibleWorkspaceIds(list))
      .toEqual([project.workspaceId, first, third, second]);

    await page.reload();
    await waitForSidebarHydration(page);
    await expect
      .poll(() => visibleWorkspaceIds(list))
      .toEqual([project.workspaceId, first, third, second]);
    for (const id of [first, second, third]) {
      await expect(treeRow(list, id)).toHaveAttribute("data-depth", "1");
      await expect(treeRow(list, id)).toHaveAttribute(
        "data-parent-workspace-id",
        project.workspaceId,
      );
    }
    await page.mouse.move(1100, 800);
    await page.screenshot({ path: testInfo.outputPath("nested-workspace-sibling-order.png") });

    await dragWorkspace(list, second, project.workspaceId, "after", -24);
    await expect
      .poll(async () => (await readWorkspace(client, project, second))?.parentWorkspaceId)
      .toBeNull();
    await expect(treeRow(list, second)).toHaveAttribute("data-depth", "0");
    await dragWorkspace(list, second, project.workspaceId, "before");
    await page.reload();
    await waitForSidebarHydration(page);
    await expect
      .poll(() => visibleWorkspaceIds(list))
      .toEqual([second, project.workspaceId, first, third]);
  } finally {
    await client.close();
    await project.cleanup();
  }
});

test("nested children collapse and remain accessible when their parent is archived", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({ repoPrefix: "workspace-tree-archive-", title: "Parent" });
  const client = await connectDaemonClient<HierarchyClient>({ clientIdPrefix: "hierarchy-read" });
  try {
    const child = await createWorkspace(project, "Child survives archive");
    const grandchild = await createWorkspace(project, "Grandchild");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const list = projectList(page, project);
    await dragWorkspace(list, child, project.workspaceId, "child");
    await dragWorkspace(list, grandchild, child, "child");
    await expect(treeRow(list, grandchild)).toHaveAttribute("data-depth", "2");

    const toggle = list.getByTestId(
      `sidebar-workspace-toggle-${getServerId()}:${project.workspaceId}`,
    );
    await toggle.click();
    await expect(workspaceRow(list, child)).toHaveCount(0);
    await expect(workspaceRow(list, grandchild)).toHaveCount(0);
    await toggle.click();
    await expect(workspaceRow(list, grandchild)).toBeVisible();
    await toggle.click();

    expect((await project.client.archiveWorkspace(project.workspaceId)).error).toBeNull();
    await expect(workspaceRow(list, project.workspaceId)).toHaveCount(0);
    await expect(treeRow(list, child)).toHaveAttribute("data-depth", "0");
    await expect(treeRow(list, grandchild)).toHaveAttribute("data-depth", "1");
    await expect
      .poll(async () => (await readWorkspace(client, project, child))?.parentWorkspaceId)
      .toBeNull();
    await expect
      .poll(async () => (await readWorkspace(client, project, grandchild))?.parentWorkspaceId)
      .toBe(child);
    await workspaceRow(list, child).click();
    await expect(page.getByTestId("workspace-header-title")).toHaveText("Child survives archive");
    await page.mouse.move(1100, 800);
    await page.screenshot({ path: testInfo.outputPath("children-after-parent-archive.png") });
  } finally {
    await client.close();
    await project.cleanup();
  }
});

test("hierarchy rejects cycles and parents from another project without changing the tree", async ({
  page,
}) => {
  const project = await seedWorkspace({ repoPrefix: "workspace-tree-cycle-", title: "Parent" });
  const other = await seedWorkspace({
    repoPrefix: "workspace-tree-other-",
    title: "Other project",
  });
  const client = await connectDaemonClient<HierarchyClient>({
    clientIdPrefix: "hierarchy-validate",
  });
  try {
    const child = await createWorkspace(project, "Child");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const list = projectList(page, project);
    await dragWorkspace(list, child, project.workspaceId, "child");
    await expect(
      client.moveWorkspace({ workspaceId: project.workspaceId, parentWorkspaceId: child }),
    ).rejects.toThrow();
    await expect(
      client.moveWorkspace({ workspaceId: child, parentWorkspaceId: other.workspaceId }),
    ).rejects.toThrow();
    await expect(treeRow(list, project.workspaceId)).toHaveAttribute("data-depth", "0");
    await expect(treeRow(list, child)).toHaveAttribute(
      "data-parent-workspace-id",
      project.workspaceId,
    );
    await expect.poll(() => visibleWorkspaceIds(list)).toEqual([project.workspaceId, child]);
  } finally {
    await client.close();
    await Promise.all([project.cleanup(), other.cleanup()]);
  }
});

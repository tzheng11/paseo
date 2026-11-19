import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  expectNewWorkspaceProjectSelected,
  openGlobalNewWorkspaceComposer,
  submitNewWorkspaceEmpty,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { openSidebarDisplayPage, openWorkspaceContextMenu } from "../support/helpers/sidebar";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { reloadPreservingHostRegistry } from "../support/helpers/hosts";
import { LAST_WORKSPACE_SELECTION_STORAGE_KEY } from "@/stores/last-workspace-selection";
import { buildHostWorkspaceRoute, buildNewWorkspaceRoute } from "@/utils/host-routes";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

const OFFLINE_SERVER_IDS = [
  "srv_e2e_preselect_offline_1",
  "srv_e2e_preselect_offline_2",
  "srv_e2e_preselect_offline_3",
];

async function findNewWorkspace(client: SeededWorkspace["client"], before: ReadonlySet<string>) {
  return (await client.fetchWorkspaces()).entries.find((workspace) => !before.has(workspace.id));
}

test.describe("Universal child workspace creation", () => {
  test.setTimeout(240_000);

  test("Add child inherits Superpinned and appends without moving existing siblings", async ({
    page,
  }, testInfo) => {
    const parent = await seedWorkspace({
      repoPrefix: "child-menu-parent-",
      title: "Manager workspace",
    });
    const other = await seedWorkspace({ repoPrefix: "child-menu-other-", title: "Existing IC" });
    const parentKey = `${getServerId()}:${parent.workspaceId}`;
    const siblingKey = `${getServerId()}:${other.workspaceId}`;
    try {
      await parent.client.setWorkspaceSuperpinned(parent.workspaceId, true);
      await other.client.setWorkspaceSuperpinned(other.workspaceId, true);
      await other.client.setWorkspacePinPlacement({
        workspaceId: other.workspaceId,
        placement: { parentWorkspaceKey: parentKey, siblingOrder: 8192 },
        expectedRevision: 0,
      });
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openWorkspaceContextMenu(page, parent.workspaceId);
      await page.getByTestId(`sidebar-workspace-menu-add-child-${parentKey}`).click();
      await expect(page).toHaveURL(/\/new\?/);
      await expectNewWorkspaceProjectSelected(page, parent.projectDisplayName);
      await expect(page.getByTestId("new-workspace-parent-picker-trigger")).toContainText(
        "Manager workspace",
      );
      const before = new Set(
        (await parent.client.fetchWorkspaces()).entries.map((workspace) => workspace.id),
      );
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 60_000 });
      let child:
        | Awaited<ReturnType<typeof parent.client.fetchWorkspaces>>["entries"][number]
        | undefined;
      await expect
        .poll(async () => {
          child = await findNewWorkspace(parent.client, before);
          return child?.pinPlacement?.parentWorkspaceKey;
        })
        .toBe(parentKey);
      expect(child?.superpinnedAt).toBeTruthy();
      expect(child?.pinPlacement?.siblingOrder).toBeGreaterThan(8192);
      const sibling = (await other.client.fetchWorkspaces()).entries.find(
        (workspace) => workspace.id === other.workspaceId,
      );
      expect(sibling?.pinPlacement).toEqual({
        parentWorkspaceKey: parentKey,
        siblingOrder: 8192,
        revision: 1,
      });
      const childRow = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${child!.id}`);
      await expect(childRow).toBeVisible();
      const siblingRow = page.getByTestId(`sidebar-workspace-row-${siblingKey}`);
      expect((await childRow.boundingBox())!.y).toBeGreaterThan(
        (await siblingRow.boundingBox())!.y,
      );
      await page.screenshot({ path: testInfo.outputPath("superpinned-child-created.png") });
    } finally {
      await parent.cleanup();
      await other.cleanup();
    }
  });

  test("parent picker creates an unpinned child on another host and None renders the shared tree", async ({
    page,
  }, testInfo) => {
    const remote = await startIsolatedHostDaemon("child-picker-remote");
    const local = await seedWorkspace({
      repoPrefix: "child-picker-local-",
      title: "Local project",
    });
    const parent = await seedWorkspace({
      repoPrefix: "child-picker-parent-",
      title: "Remote manager",
      port: remote.port,
    });
    const parentKey = `${remote.serverId}:${parent.workspaceId}`;
    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "Local host",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        { serverId: remote.serverId, label: "Remote host", endpoint: `127.0.0.1:${remote.port}` },
      ]);
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openSidebarDisplayPage(page, "sidebar-display-grouping");
      await page.getByTestId("sidebar-grouping-none").click();
      await expect(page.getByTestId("sidebar-ungrouped-list")).toBeVisible();
      await expect(page.locator('[data-testid^="sidebar-project-row-"]')).toHaveCount(0);
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: local.workspaceId,
      });
      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, local.projectDisplayName);
      await page.getByTestId("new-workspace-parent-picker-trigger").click();
      await page.getByTestId(`new-workspace-parent-option-${parentKey}`).click();
      await expect(page.getByTestId("new-workspace-parent-picker-trigger")).toContainText(
        "Remote manager",
      );
      const before = new Set(
        (await local.client.fetchWorkspaces()).entries.map((workspace) => workspace.id),
      );
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(new RegExp(`/h/${getServerId()}/workspace/`), {
        timeout: 60_000,
      });
      let child:
        | Awaited<ReturnType<typeof local.client.fetchWorkspaces>>["entries"][number]
        | undefined;
      await expect
        .poll(async () => {
          child = await findNewWorkspace(local.client, before);
          return child?.pinPlacement?.parentWorkspaceKey;
        })
        .toBe(parentKey);
      expect(child?.pinnedAt).toBeFalsy();
      expect(child?.superpinnedAt).toBeFalsy();
      const childRow = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${child!.id}`);
      const parentRow = page.getByTestId(`sidebar-workspace-row-${parentKey}`);
      await expect(childRow).toBeVisible();
      await expect(parentRow).toBeVisible();
      await expect
        .poll(async () => (await childRow.boundingBox())!.x - (await parentRow.boundingBox())!.x)
        .toBe(16);
      await reloadPreservingHostRegistry(page);
      await expect(childRow).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("sidebar-ungrouped-list")).toBeVisible();
      await expect
        .poll(async () => (await childRow.boundingBox())!.x - (await parentRow.boundingBox())!.x)
        .toBe(16);
      await page.screenshot({ path: testInfo.outputPath("ungrouped-cross-host-child.png") });
    } finally {
      await local.cleanup();
      await parent.cleanup();
      await remote.close();
    }
  });
});

// New Workspace preselection is a form-context decision, not startup routing.
// Entry points from a workspace should carry the current project context, and a
// plain /new must not let a stale remembered offline host steal the initial host
// when there is exactly one online saved host.

async function pressNewWorkspaceShortcut(page: import("@playwright/test").Page): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+n`);
  await expect(page).toHaveURL(/\/new(?:\?.*)?$/, { timeout: 30_000 });
}

async function expectProjectPreselectedWithin(
  page: import("@playwright/test").Page,
  projectDisplayName: string,
  timeout: number,
): Promise<void> {
  const projectPicker = page.getByRole("button", { name: "Workspace project" });
  await expect(projectPicker).toContainText(projectDisplayName, { timeout });
}

async function expectAnyProjectPreselectedWithin(
  page: import("@playwright/test").Page,
  timeout: number,
): Promise<void> {
  const projectPicker = page.getByRole("button", { name: "Workspace project" });
  await expect(projectPicker).toBeVisible({ timeout });
  await expect
    .poll(
      async () => {
        const label = ((await projectPicker.textContent()) ?? "").trim();
        return label || "Choose project";
      },
      { timeout },
    )
    .not.toBe("Choose project");
}

async function openColdRestoredWorkspaceWithOfflineHostFirst(
  page: import("@playwright/test").Page,
  workspace: SeededWorkspace,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId, workspaceId }) => {
      localStorage.setItem(storageKey, JSON.stringify({ serverId, workspaceId }));
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: connectedServerId,
      workspaceId: workspace.workspaceId,
    },
  );

  await page.goto("/");
  await expect(page).toHaveURL(buildHostWorkspaceRoute(connectedServerId, workspace.workspaceId), {
    timeout: 60_000,
  });
  await waitForSidebarHydration(page);
}

async function openNewWorkspaceWithStaleOfflineSelection(
  page: import("@playwright/test").Page,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ serverId, workspaceId: "wks_stale_offline" }),
      );
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: OFFLINE_SERVER_IDS[0]!,
    },
  );

  await page.goto(buildNewWorkspaceRoute());
  await expect(page.getByTestId("host-picker-trigger")).toBeVisible({ timeout: 60_000 });
}

async function seedOfflineHostsWithStaleSelection(
  page: import("@playwright/test").Page,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ serverId, workspaceId: "wks_stale_offline" }),
      );
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: OFFLINE_SERVER_IDS[0]!,
    },
  );
}

test.describe("New workspace preselects the open workspace's project", () => {
  test.describe.configure({ timeout: 240_000 });

  let projectA: SeededWorkspace;
  let projectB: SeededWorkspace;

  test.beforeEach(async () => {
    projectA = await seedWorkspace({ repoPrefix: "preselect-a-" });
    projectB = await seedWorkspace({ repoPrefix: "preselect-b-" });
  });

  test.afterEach(async () => {
    await projectA?.cleanup();
    await projectB?.cleanup();
  });

  test("Cmd+N preselects the project you are looking at", async ({ page }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectB.workspaceId,
    });
    await pressNewWorkspaceShortcut(page);
    await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectA.workspaceId,
    });
    await pressNewWorkspaceShortcut(page);
    await expectNewWorkspaceProjectSelected(page, projectA.projectDisplayName);
  });

  test("New workspace button preselects the project you are looking at", async ({ page }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectB.workspaceId,
    });
    await openGlobalNewWorkspaceComposer(page);
    await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectA.workspaceId,
    });
    await openGlobalNewWorkspaceComposer(page);
    await expectNewWorkspaceProjectSelected(page, projectA.projectDisplayName);
  });

  test("Cmd+N preselects the connected host project when an offline saved host is first", async ({
    page,
  }) => {
    await openColdRestoredWorkspaceWithOfflineHostFirst(page, projectB);

    await pressNewWorkspaceShortcut(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, projectB.projectDisplayName, 8_000);
  });

  test("New workspace button preselects the connected host project when an offline saved host is first", async ({
    page,
  }) => {
    await openColdRestoredWorkspaceWithOfflineHostFirst(page, projectB);

    await openGlobalNewWorkspaceComposer(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, projectB.projectDisplayName, 8_000);
  });

  test("plain /new ignores stale remembered offline hosts when only one saved host is connected", async ({
    page,
  }) => {
    await openNewWorkspaceWithStaleOfflineSelection(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectAnyProjectPreselectedWithin(page, 8_000);
  });

  test("stale remembered offline host heals after visiting the connected workspace", async ({
    page,
  }) => {
    const connectedServerId = getServerId();
    await seedOfflineHostsWithStaleSelection(page);

    await page.goto(buildHostWorkspaceRoute(connectedServerId, projectB.workspaceId));
    await expect(page).toHaveURL(buildHostWorkspaceRoute(connectedServerId, projectB.workspaceId), {
      timeout: 60_000,
    });
    await waitForSidebarHydration(page);

    await openGlobalNewWorkspaceComposer(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, projectB.projectDisplayName, 8_000);
  });
});

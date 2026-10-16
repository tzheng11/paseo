import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  closeProjectContextMenu,
  closeWorkspaceContextMenu,
  expectProjectContextMenuActions,
  expectWorkspaceContextMenuActions,
  expectWorkspaceContextMenuOwnsAttention,
  expectWorkspaceRowHoverCleared,
  openProjectContextMenu,
  openWorkspaceContextMenu,
  showWorkspaceHoverCard,
} from "../support/helpers/sidebar";

test.describe("Sidebar context menus", () => {
  test("right-clicking workspace and project rows opens their actions at the pointer", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-context-menu-" });

    try {
      await gotoAppShell(page);

      await showWorkspaceHoverCard(page, workspace.workspaceId);
      await openWorkspaceContextMenu(page, workspace.workspaceId);
      await expectWorkspaceContextMenuActions(page, workspace.workspaceId);
      await expectWorkspaceContextMenuOwnsAttention(page);

      await closeWorkspaceContextMenu(page, workspace.workspaceId);
      await expectWorkspaceRowHoverCleared(page, workspace.workspaceId);
      await openProjectContextMenu(page, workspace.projectKey);
      await expectProjectContextMenuActions(page, workspace.projectKey);

      await closeProjectContextMenu(page, workspace.projectKey);
    } finally {
      await workspace.cleanup();
    }
  });
});

function headerAction(page: Page, workspaceId: string, action: string) {
  return page.getByTestId(`workspace-header-${action}-${getServerId()}:${workspaceId}`);
}

async function openHeaderMenu(page: Page) {
  await page.getByTestId("workspace-header-menu-trigger").click();
}

test.describe("Workspace header action parity", () => {
  test("pins, renames, labels and archives while the sidebar row is unmounted", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "header-workspace-actions-" });
    try {
      await workspace.client.setWorkspaceLabel({
        workspaceId: workspace.workspaceId,
        label: { name: "Urgent", color: "red" },
        assigned: true,
      });
      await gotoAppShell(page);
      const row = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      await expect(page.getByTestId("workspace-header-title")).toBeVisible();
      await page
        .locator('[data-testid^="sidebar-project-row-"]')
        .filter({ hasText: workspace.projectDisplayName })
        .click();
      await expect(row).toHaveCount(0);
      await openHeaderMenu(page);
      for (const action of ["rename", "pin", "labels", "archive"])
        await expect(headerAction(page, workspace.workspaceId, action)).toBeVisible();
      await expect(page.getByTestId("workspace-header-copy-path")).toBeVisible();
      await expect(page.getByTestId("workspace-header-copy-branch-name")).toBeVisible();
      await expect(page.getByTestId("workspace-header-import-agent")).toBeVisible();
      await headerAction(page, workspace.workspaceId, "pin").click();
      await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
      await openHeaderMenu(page);
      await expect(headerAction(page, workspace.workspaceId, "pin")).toHaveText("Unpin");
      await headerAction(page, workspace.workspaceId, "rename").click();
      const input = page.getByTestId("workspace-header-rename-modal-input");
      await expect(input).toBeFocused();
      await input.fill("Header actions work");
      await page.getByTestId("workspace-header-rename-modal-submit").click();
      await expect(page.getByTestId("workspace-header-title")).toHaveText("Header actions work");
      await openHeaderMenu(page);
      await headerAction(page, workspace.workspaceId, "labels").click();
      const label = page.getByTestId("workspace-label-picker-row-Urgent");
      await expect(label).toHaveAttribute("aria-checked", "true");
      await label.click();
      await expect(label).toHaveAttribute("aria-checked", "false");
      await expect.poll(async () => (await readWorkspace(workspace))?.labels ?? []).toEqual([]);
      await page.keyboard.press("Escape");
      await openHeaderMenu(page);
      await headerAction(page, workspace.workspaceId, "pin").click();
      await expect(page.getByTestId("sidebar-pinned-section")).toHaveCount(0);
      await openHeaderMenu(page);
      await expect(headerAction(page, workspace.workspaceId, "pin")).toHaveText("Pin to top");
      await headerAction(page, workspace.workspaceId, "archive").click();
      await expect.poll(() => readWorkspace(workspace)).toBeUndefined();
      await expect(page.getByTestId("workspace-header-title")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("header archive preserves the dirty-worktree confirmation and cancellation", async ({
    page,
  }) => {
    const seeded = await seedWorkspace({ repoPrefix: "header-archive-risk-" });
    try {
      const created = await seeded.client.createWorkspace({
        source: {
          kind: "worktree",
          projectId: seeded.projectId,
          action: "branch-off",
          refName: "main",
          worktreeSlug: "header-risk",
        },
      });
      if (!created.workspace) throw new Error(created.error ?? "Missing test worktree");
      const workspace = created.workspace;
      await writeFile(path.join(workspace.workspaceDirectory, "UNSAVED.txt"), "keep me\n");
      expect((await seeded.client.checkoutRefresh(workspace.workspaceDirectory)).success).toBe(
        true,
      );
      await gotoAppShell(page);
      const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.id}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      await openHeaderMenu(page);
      const cancelled = page.waitForEvent("dialog");
      const cancelClick = headerAction(page, workspace.id, "archive").click();
      const dialog = await cancelled;
      expect(dialog.message()).toContain("uncommitted");
      await dialog.dismiss();
      await cancelClick;
      await expect(row).toBeVisible();
      await openHeaderMenu(page);
      const accepted = page.waitForEvent("dialog");
      const confirmClick = headerAction(page, workspace.id, "archive").click();
      await (await accepted).accept();
      await confirmClick;
      await expect(row).toHaveCount(0);
    } finally {
      await seeded.cleanup();
    }
  });

  test("compact header keeps workspace actions and label pages alongside new-tab actions", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "header-workspace-compact-" });
    try {
      await gotoAppShell(page);
      const row = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      await page.setViewportSize({ width: 390, height: 844 });
      await openHeaderMenu(page);
      await expect(
        page.getByRole("button", { name: "Bottom sheet backdrop" }).first(),
      ).toBeVisible();
      await expect(page.getByTestId("workspace-header-new-agent")).toBeVisible();
      for (const action of ["rename", "pin", "labels", "archive"])
        await expect(headerAction(page, workspace.workspaceId, action)).toBeVisible();
      await headerAction(page, workspace.workspaceId, "labels").click();
      await expect(page.getByTestId("workspace-label-picker-create")).toBeVisible();
      await page.getByTestId("workspace-label-picker-create").click();
      await expect(page.getByTestId("workspace-label-picker-create-name")).toBeFocused();
    } finally {
      await workspace.cleanup();
    }
  });

  test("mark unread/read uses the active canonical workspace", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "header-mark-unread-",
      title: "Read state",
      initialPrompt: "Finish.",
    });
    try {
      await workspace.client.waitForFinish(workspace.agentId, 20_000);
      await workspace.client.clearWorkspaceAttention(workspace.workspaceId);
      await gotoAppShell(page);
      const row = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      await openHeaderMenu(page);
      await headerAction(page, workspace.workspaceId, "mark-as-unread").click();
      await expect(row.getByTestId("workspace-status-indicator-attention")).toBeVisible();
      await openHeaderMenu(page);
      await headerAction(page, workspace.workspaceId, "mark-as-read").click();
      await expect(row.getByTestId("workspace-status-indicator-done")).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });

  test("failed pin leaves an error visible and can be retried from the header", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "header-pin-failure-" });
    try {
      await rejectFirstPin(page);
      await gotoAppShell(page);
      const row = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      await openHeaderMenu(page);
      await headerAction(page, workspace.workspaceId, "pin").click();
      await expect(page.getByTestId("app-toast-message")).toContainText("Pin rejected by test.");
      await openHeaderMenu(page);
      await expect(headerAction(page, workspace.workspaceId, "pin")).toHaveText("Pin to top");
      await headerAction(page, workspace.workspaceId, "pin").click();
      await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
});

async function rejectFirstPin(page: Page) {
  let reject = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const envelope = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
      const request = envelope.type === "session" ? envelope.message : null;
      if (reject && request?.type === "workspace.pin.set.request") {
        reject = false;
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId: request.requestId,
                requestType: request.type,
                error: "Pin rejected by test.",
                code: "transport",
              },
            },
          }),
        );
      } else server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
}

async function readWorkspace(workspace: Awaited<ReturnType<typeof seedWorkspace>>) {
  return (await workspace.client.fetchWorkspaces()).entries.find(
    (entry) => entry.id === workspace.workspaceId,
  );
}

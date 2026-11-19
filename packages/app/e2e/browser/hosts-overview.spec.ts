import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "../support/fixtures";
import {
  composerLocator,
  enterComposerFullscreen,
  exitComposerFullscreen,
} from "../support/helpers/composer";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  expectNewWorkspaceDraft,
  fillNewWorkspaceDraft,
  openGlobalNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { addScheduleHostAndReload } from "../support/helpers/schedule-host";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

/** The table makes the home screen taller; the community links must stay below the tiles. */
async function expectTilesClearOfCommunityLinks(page: Page): Promise<void> {
  const tile = await page.getByTestId("open-project-setup-providers").boundingBox();
  const links = await page.getByText("Sponsor", { exact: true }).boundingBox();
  if (!tile || !links) throw new Error("Expected the tiles and community links to render.");
  expect(links.y).toBeGreaterThanOrEqual(tile.y + tile.height);
}

test("the home screen shows each host's work and load and marks the next host", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const secondary = await startIsolatedHostDaemon(`srv_hosts_${randomUUID()}`);
  const workspace = await seedWorkspace({ repoPrefix: "hosts-overview-", port: secondary.port });
  try {
    await page.goto("/open-project");
    await addScheduleHostAndReload({
      page,
      serverId: secondary.serverId,
      label: "Second host",
      port: secondary.port,
    });
    await page.goto("/open-project");

    const overview = page.getByTestId("hosts-overview");
    const primaryRow = page.getByTestId(`hosts-overview-row-${process.env.E2E_SERVER_ID}`);
    const secondaryRow = page.getByTestId(`hosts-overview-row-${secondary.serverId}`);

    await expect(secondaryRow).toContainText("Second host");
    // One workspace, no agents, nothing running: active / total.
    await expect(secondaryRow).toContainText("0 / 1");
    await expect(secondaryRow).toContainText("0 / 0");
    for (const row of [primaryRow, secondaryRow]) {
      await expect(row).toContainText(/\d+%/);
      await expect(row).toContainText(/of \d+ cores/);
      await expect(row).toContainText(/[\d.]+ \/ [\d.]+ GB/);
    }
    await expect(overview.getByText("Next", { exact: true })).toHaveCount(1);
    await expectTilesClearOfCommunityLinks(page);
    await page.screenshot({ path: testInfo.outputPath("hosts-overview-desktop.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(secondaryRow).toContainText("0/1 workspaces · 0/0 agents");
    await expectTilesClearOfCommunityLinks(page);
    await page.screenshot({ path: testInfo.outputPath("hosts-overview-compact.png") });
  } finally {
    await workspace.cleanup();
    await secondary.close();
  }
});

test("New workspace shows host load while keeping the composer accessible", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const secondary = await startIsolatedHostDaemon(`srv_new_workspace_hosts_${randomUUID()}`);
  const primaryWorkspace = await seedWorkspace({ repoPrefix: "new-workspace-primary-host-" });
  const secondaryWorkspace = await seedWorkspace({
    repoPrefix: "new-workspace-secondary-host-",
    port: secondary.port,
  });
  const draft = "Compare these hosts\nKeep the composer accessible\nPreserve this draft";
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/open-project");
    await addScheduleHostAndReload({
      page,
      serverId: secondary.serverId,
      label: "Second host",
      port: secondary.port,
    });
    await waitForSidebarHydration(page);
    await openGlobalNewWorkspaceComposer(page);

    // The previous home route stays mounted beneath New workspace.
    const overview = page.getByTestId("hosts-overview").filter({ visible: true });
    const primaryRow = overview.getByTestId(`hosts-overview-row-${process.env.E2E_SERVER_ID}`);
    const secondaryRow = overview.getByTestId(`hosts-overview-row-${secondary.serverId}`);
    const composer = composerLocator(page);
    const projectPicker = page.getByTestId("new-workspace-project-picker-trigger");

    await expect(overview).toBeVisible();
    await expect(secondaryRow).toContainText("Second host");
    for (const row of [primaryRow, secondaryRow]) {
      await expect(row).toContainText("0 / 1");
      await expect(row).toContainText("0 / 0");
      await expect(row).toContainText(/\d+%/);
      await expect(row).toContainText(/of \d+ cores/);
      await expect(row).toContainText(/[\d.]+ \/ [\d.]+ GB/);
    }
    await expect(overview.getByText("Next", { exact: true })).toHaveCount(1);
    await secondaryRow.scrollIntoViewIfNeeded();
    await expect(secondaryRow).toBeInViewport();
    await expect(projectPicker).toBeInViewport({ ratio: 1 });
    await expect(composer).toBeInViewport({ ratio: 1 });
    await fillNewWorkspaceDraft(page, draft);
    await expectNewWorkspaceDraft(page, draft);
    await page.screenshot({ path: testInfo.outputPath("new-workspace-hosts-desktop.png") });

    await page.setViewportSize({ width: 1440, height: 700 });
    await projectPicker.scrollIntoViewIfNeeded();
    await expect(projectPicker).toBeInViewport({ ratio: 1 });
    await expect(composer).toBeInViewport({ ratio: 1 });
    await secondaryRow.scrollIntoViewIfNeeded();
    await expect(secondaryRow).toBeInViewport({ ratio: 1 });
    await expect(projectPicker).toBeInViewport({ ratio: 1 });
    await expect(composer).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("new-workspace-hosts-short-desktop.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(secondaryRow).toContainText("0/1 workspaces · 0/0 agents");
    for (const row of [primaryRow, secondaryRow]) {
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeInViewport();
      await expect(projectPicker).toBeInViewport({ ratio: 1 });
      await expect(composer).toBeInViewport({ ratio: 1 });
    }
    await expectNewWorkspaceDraft(page, draft);
    await composer.press("End");
    await composer.pressSequentially(" on compact");
    await expectNewWorkspaceDraft(page, `${draft} on compact`);
    await page.screenshot({ path: testInfo.outputPath("new-workspace-hosts-compact.png") });

    await enterComposerFullscreen(page);
    await expect(page.getByTestId("composer-fullscreen")).toBeVisible();
    await expect(overview).toHaveCount(0);
    await expect(composer).toBeInViewport({ ratio: 1 });
    await exitComposerFullscreen(page);
    await expect(overview).toBeVisible();
    await expectNewWorkspaceDraft(page, `${draft} on compact`);
  } finally {
    await primaryWorkspace.cleanup();
    await secondaryWorkspace.cleanup();
    await secondary.close();
  }
});

test("an older daemon asks for an update instead of showing zeros", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const old = await startIsolatedHostDaemon(`srv_hosts_old_${randomUUID()}`, {
    publishedVersion: "0.8.0",
  });
  try {
    await page.goto("/open-project");
    await addScheduleHostAndReload({
      page,
      serverId: old.serverId,
      label: "Old host",
      port: old.port,
    });
    await page.goto("/open-project");

    const row = page.getByTestId(`hosts-overview-row-${old.serverId}`);
    await expect(row).toContainText("Update this host to see its load", { timeout: 30_000 });
    await expect(row).not.toContainText("%");
    await expect(row.getByText("Next", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId(`hosts-overview-row-${process.env.E2E_SERVER_ID}`)).toContainText(
      "Next",
    );
    await page.screenshot({ path: testInfo.outputPath("hosts-overview-old-daemon.png") });
  } finally {
    await old.close();
  }
});

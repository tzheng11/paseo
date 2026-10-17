import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { addScheduleHostAndReload } from "../support/helpers/schedule-host";
import { seedWorkspace } from "../support/helpers/seed-client";

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

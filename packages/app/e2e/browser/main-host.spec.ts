import { randomUUID } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { addScheduleHostAndReload } from "../support/helpers/schedule-host";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

test("Main host starts unset and the first app choice reaches both daemons", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const secondary = await startIsolatedHostDaemon(`srv_main_${randomUUID()}`);
  const primaryClient = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "main-primary" });
  const secondaryClient = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "main-secondary",
    port: secondary.port,
  });
  try {
    await page.setViewportSize({ width: 1440, height: 940 });
    await page.goto("/open-project");
    await addScheduleHostAndReload({
      page,
      serverId: secondary.serverId,
      label: "Second host",
      port: secondary.port,
    });
    await page.goto("/open-project");
    await expect(page.getByTestId("main-host-status")).toContainText("No main host yet");
    await expect(page.getByTestId(`make-main-${secondary.serverId}`)).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("main-unset-1440.png") });
    await page.getByTestId(`make-main-${secondary.serverId}`).click();
    await expect(page.getByTestId("main-host-confirmation")).toContainText(
      "This is the first choice",
    );
    await page.screenshot({ path: testInfo.outputPath("main-first-set-1440.png") });
    await page.getByTestId("confirm-main-host").click();
    await expect(
      page
        .getByTestId(`hosts-overview-row-${secondary.serverId}`)
        .getByText("Main", { exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await primaryClient.getMainHost()).state.held).toBe(false);
    const primary = (await primaryClient.getMainHost()).state;
    const second = (await secondaryClient.getMainHost()).state;
    expect(primary.choice?.generation).toBe(1);
    expect(primary.choice?.mainHost).toBe(secondary.serverId);
    expect(primary.choice).toEqual(second.choice);
    expect(primary.delivery?.allocationId).toBe(primary.choice?.allocationId);
    await page.screenshot({ path: testInfo.outputPath("main-set-1440.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page
        .getByTestId(`hosts-overview-row-${secondary.serverId}`)
        .getByText("Main", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("main-set-390.png") });
  } finally {
    await primaryClient.close();
    await secondaryClient.close();
    await secondary.close();
  }
});

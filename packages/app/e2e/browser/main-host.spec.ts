import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { z } from "zod";
import type { DaemonClient, DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { MainHostState } from "@getpaseo/protocol/fleet/main-host";
import { test, expect, type Page } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { addScheduleHostAndReload } from "../support/helpers/schedule-host";
import {
  connectDaemonClient,
  loadDaemonClientConstructor,
  loadProtocolSchemas,
} from "../support/helpers/daemon-client-loader";
import { createNodeWebSocketFactory } from "../support/helpers/node-ws-factory";
import {
  daemonWsRoutePattern,
  getE2EDaemonPort,
  wsRoutePatternForPort,
} from "../support/helpers/daemon-port";
import {
  expectNewWorkspaceProjectSelected,
  loadSessionMessageReaders,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import { createTempGitRepo } from "../support/helpers/workspace";

async function chooseMain(page: Page, serverId: string) {
  await page.getByTestId(`make-main-${serverId}`).click();
  await expect(page.getByTestId("main-host-confirmation")).toBeVisible();
  await page.getByTestId("confirm-main-host").click();
}

async function expectDelivered(client: DaemonClient, mainHost: string | null, generation: number) {
  await expect
    .poll(async () => {
      const state = (await client.getMainHost()).state;
      return {
        mainHost: state.choice?.mainHost,
        generation: state.choice?.generation,
        held: state.held,
      };
    })
    .toEqual({ mainHost, generation, held: false });
}

async function withoutMainCapability(page: Page) {
  const { WSHelloMessageSchema } = await loadProtocolSchemas();
  const frameSchema = z.record(z.string(), z.unknown());
  await page.routeWebSocket(/\/ws(?:\?|$)/, (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      const envelope = frameSchema.safeParse(JSON.parse(frame.toString()));
      const hello = WSHelloMessageSchema.safeParse(envelope.success ? envelope.data : null);
      server.send(
        hello.success
          ? JSON.stringify({
              ...hello.data,
              capabilities: { ...hello.data.capabilities, main_host: false },
            })
          : frame,
      );
    });
    server.onMessage((frame) => browser.send(frame));
  });
}

async function holdMainReads(page: Page) {
  const frames = await loadSessionMessageReaders();
  const pending: Array<() => void> = [];
  let hold = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    server.onMessage((frame) => {
      if (hold && frames.server(frame)?.type === "fleet.main_host.get.response")
        pending.push(() => browser.send(frame));
      else browser.send(frame);
    });
    browser.onMessage((frame) => server.send(frame));
  });
  return () => {
    hold = false;
    for (const release of pending) release();
  };
}

async function oldClient() {
  const Client = await loadDaemonClientConstructor<DaemonClientConfig, DaemonClient>();
  const client = new Client({
    url: `ws://127.0.0.1:${getE2EDaemonPort()}/ws`,
    clientId: `old-main-client-${randomUUID()}`,
    clientType: "cli",
    capabilities: { main_host: false },
    webSocketFactory: createNodeWebSocketFactory(),
  });
  await client.connect();
  return client;
}

test("Main host: unset → first-set → conflict → reconnect → Undo → old-client refusal", async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  let secondary = await startIsolatedHostDaemon(`srv_main_${randomUUID()}`, { preserveHome: true });
  const secondaryHome = secondary.paseoHome;
  const primaryClient = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "main-primary" });
  let secondaryClient = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "main-secondary",
    port: secondary.port,
  });
  const primaryId = (await primaryClient.getMainHost()).allocator.serverId;
  const frames = await loadSessionMessageReaders();
  let loseUndoAckFor: string | undefined;
  let loseUndoAllocationAckFor: string | undefined;
  let undoAllocationAckLost = false;
  let undoAckLost = false;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => server.send(frame));
    server.onMessage((frame) => {
      const message = frames.server(frame);
      if (
        loseUndoAllocationAckFor &&
        message?.type === "fleet.main_host.set.response" &&
        message.payload.state.choice?.undoOf === loseUndoAllocationAckFor
      ) {
        loseUndoAllocationAckFor = undefined;
        undoAllocationAckLost = true;
        void browser.close({ code: 1001, reason: "Main Undo allocation acknowledgement lost" });
        void server.close({ code: 1001, reason: "Main Undo allocation acknowledgement lost" });
        return;
      }
      if (
        loseUndoAckFor &&
        message?.type === "fleet.main_host.apply.response" &&
        message.payload.allocator.serverId === secondary.serverId &&
        message.payload.state.choice?.undoOf === loseUndoAckFor
      ) {
        loseUndoAckFor = undefined;
        undoAckLost = true;
        // Persist the real receipt, then lose only its acknowledgement on the app connection.
        void browser.close({ code: 1001, reason: "Main Undo acknowledgement lost" });
        void server.close({ code: 1001, reason: "Main Undo acknowledgement lost" });
      } else browser.send(frame);
    });
  });
  let closeObserver = async () => {};
  const projectCleanups: Array<() => Promise<void>> = [];
  try {
    await test.step("Unset and first app confirmation at the fixed desktop and mobile widths", async () => {
      await page.setViewportSize({ width: 1440, height: 940 });
      await page.goto("/open-project");
      await addScheduleHostAndReload({
        page,
        serverId: secondary.serverId,
        label: "Second host",
        port: secondary.port,
      });
      await expect(page.getByTestId("main-host-status")).toContainText("No main host yet");
      await expect(page.getByTestId(`make-main-${secondary.serverId}`)).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath("main-unset-1440.png") });
      await page.getByTestId(`make-main-${secondary.serverId}`).click();
      await expect(page.getByTestId("main-host-confirmation")).toContainText(
        "This is the first choice",
      );
      await page.screenshot({ path: testInfo.outputPath("main-first-set-1440.png") });
      const browser = page.context().browser();
      if (!browser) throw new Error("The Main flow needs a real browser.");
      const observerContext = await browser.newContext({
        storageState: await page.context().storageState(),
        baseURL: new URL(page.url()).origin,
      });
      closeObserver = () => observerContext.close();
      const observer = await observerContext.newPage();
      await observer.goto("/open-project");
      await expect(observer.getByTestId("main-host-status")).toContainText("No main host yet");
      const projectChoices: Array<{ projectKey: string; projectDisplayName: string }> = [];
      for (const prefix of ["aa-main-default-", "zz-main-manual-"]) {
        const repository = await createTempGitRepo(prefix);
        projectCleanups.push(repository.cleanup);
        const result = await primaryClient.addProject(repository.path);
        const project = result.project;
        if (!project?.projectKey)
          throw new Error(result.error ?? "Main regression project needs its registered key");
        projectCleanups.push(async () => {
          await primaryClient.removeProject(project.projectId);
        });
        projectChoices.push({
          projectKey: project.projectKey,
          projectDisplayName: project.projectDisplayName,
        });
      }
      await observer.setViewportSize({ width: 1440, height: 940 });
      await observer.goto("/new");
      await selectNewWorkspaceProject(observer, projectChoices[1]);
      const draft = observer.getByRole("textbox", { name: "Message agent..." });
      await draft.fill("Keep this manually chosen project when Main changes");
      const unchosen = await observerContext.newPage();
      await unchosen.goto("/new");
      await expect(unchosen.getByTestId("host-picker-trigger")).toContainText("localhost");
      await observer.screenshot({
        path: testInfo.outputPath("main-manual-project-before-1440.png"),
      });
      await page.getByTestId("confirm-main-host").click();
      // Both forms observe the other app's new Main. Only the unchosen form follows it.
      await expect(unchosen.getByTestId("host-picker-trigger")).toContainText("Second host");
      await expect(observer.getByTestId("host-picker-trigger")).toContainText("localhost");
      await expectNewWorkspaceProjectSelected(observer, projectChoices[1].projectDisplayName);
      await expect(draft).toHaveValue("Keep this manually chosen project when Main changes");
      await observer.screenshot({
        path: testInfo.outputPath("main-manual-project-after-1440.png"),
      });
      await observer.goto("/open-project");
      await expect(
        observer
          .getByTestId(`hosts-overview-row-${secondary.serverId}`)
          .getByText("Main", { exact: true }),
      ).toBeVisible({ timeout: 10_000 });
      await closeObserver();
      await expectDelivered(primaryClient, secondary.serverId, 1);
      await expectDelivered(secondaryClient, secondary.serverId, 1);
      const primary = (await primaryClient.getMainHost()).state;
      expect(primary.choice).toEqual((await secondaryClient.getMainHost()).state.choice);
      expect(primary.delivery?.allocationId).toBe(primary.choice?.allocationId);
      await page.goto("/open-project");
      await expect(
        page
          .getByTestId(`hosts-overview-row-${secondary.serverId}`)
          .getByText("Main", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("main-set-1440.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page
          .getByTestId(`hosts-overview-row-${secondary.serverId}`)
          .getByText("Main", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("main-set-390.png") });
      await page.setViewportSize({ width: 1440, height: 940 });
    });

    await test.step("Two daemons allocate concurrently; equal-generation disagreement has no automatic winner", async () => {
      await Promise.all([
        primaryClient.setMainHost({
          mainHost: primaryId,
          expectedGeneration: 1,
          requestId: "conflict-a",
        }),
        secondaryClient.setMainHost({
          mainHost: secondary.serverId,
          expectedGeneration: 1,
          requestId: "conflict-b",
        }),
      ]);
      await expect(page.getByTestId("main-host-status")).toContainText("Hosts disagree about Main");
      await expect(page.getByTestId(`main-choice-${primaryId}`)).toContainText("generation 2");
      await expect(page.getByTestId(`main-choice-${secondary.serverId}`)).toContainText(
        "generation 2",
      );
      const before = (await primaryClient.getMainHost()).state;
      const other = (await secondaryClient.getMainHost()).state;
      expect(before.choice?.allocationId).not.toBe(other.choice?.allocationId);
      await page.screenshot({ path: testInfo.outputPath("main-conflict-1440.png") });
      await chooseMain(page, secondary.serverId);
      await expectDelivered(primaryClient, secondary.serverId, 3);
      await expectDelivered(secondaryClient, secondary.serverId, 3);
      await page.goto("/open-project");
    });

    await test.step("Held CLI change needs explicit delivery; a disconnected daemon catches up on reconnect", async () => {
      await secondaryClient.close();
      await secondary.close();
      await expect(page.getByTestId(`hosts-overview-row-${secondary.serverId}`)).toContainText(
        /offline|connect/i,
      );
      await primaryClient.setMainHost({
        mainHost: primaryId,
        expectedGeneration: 3,
        requestId: "offline-change",
      });
      await expect(page.getByTestId("main-host-status")).toContainText(
        "Main host change needs you",
      );
      await expect(page.getByTestId("main-host-status")).toContainText("cli session main-primary");
      await expect(page.getByTestId("main-host-status")).toContainText(
        "changed Main from Second host to localhost",
      );
      await page.screenshot({ path: testInfo.outputPath("main-held-1440.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("main-held-390.png") });
      await page.setViewportSize({ width: 1440, height: 940 });
      await page.getByTestId("deliver-main-host").click();
      await expectDelivered(primaryClient, primaryId, 4);
      secondary = await startIsolatedHostDaemon(secondary.serverId, {
        paseoHome: secondaryHome,
        preserveHome: true,
      });
      secondaryClient = await connectDaemonClient<DaemonClient>({
        clientIdPrefix: "main-reconnected",
        port: secondary.port,
      });
      expect((await secondaryClient.getMainHost()).state.choice?.generation).toBe(3);
      await addScheduleHostAndReload({
        page,
        serverId: secondary.serverId,
        label: "Second host",
        port: secondary.port,
      });
      await expectDelivered(secondaryClient, primaryId, 4);
      expect((await secondaryClient.getMainHost()).state.choice).toEqual(
        (await primaryClient.getMainHost()).state.choice,
      );
      await page.screenshot({ path: testInfo.outputPath("main-reconnected-1440.png") });
    });

    await test.step("Undo is a new allocation, preserves provenance and survives daemon restart", async () => {
      const held = (
        await primaryClient.setMainHost({
          mainHost: secondary.serverId,
          expectedGeneration: 4,
          requestId: "undo-me",
        })
      ).state;
      await expect(page.getByTestId("main-host-status")).toContainText(
        "Main host change needs you",
      );
      loseUndoAckFor = held.choice?.allocationId;
      loseUndoAllocationAckFor = held.choice?.allocationId;
      await page.getByTestId("undo-main-host").click();
      await expect.poll(() => undoAllocationAckLost).toBe(true);
      await expect(page.getByRole("button", { name: "Retry this change" })).toBeEnabled();
      const allocatedUndo = (await primaryClient.getMainHost()).state;
      expect(allocatedUndo.choice?.generation).toBe(6);
      expect(allocatedUndo.choice?.undoOf).toBe(held.choice?.allocationId);
      expect(allocatedUndo.held).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("main-undo-retry-1440.png") });
      await expect(page.getByTestId(`make-main-${primaryId}`)).toBeEnabled();
      await expect(page.getByTestId(`make-main-${secondary.serverId}`)).toBeEnabled();
      await page.getByRole("button", { name: "Retry this change" }).click();
      await expectDelivered(primaryClient, primaryId, 6);
      await expectDelivered(secondaryClient, primaryId, 6);
      const undone = (await primaryClient.getMainHost()).state;
      expect(undone.choice).toEqual(allocatedUndo.choice);
      expect(undone.choice?.undoOf).toBe(held.choice?.allocationId);
      expect(undone.choice?.setBy.clientType).toBe("browser");
      await secondary.restart();
      await secondaryClient.connect();
      await expectDelivered(secondaryClient, primaryId, 6);
      await expect.poll(() => undoAckLost).toBe(true);
      await expect(page.getByTestId("main-host-provenance")).toContainText("Set from browser");
      await expect(page.getByTestId("main-host-error")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("main-undo-1440.png") });
    });

    await test.step("A client without Main capability receives a readable refusal and changes neither daemon", async () => {
      const before = (await primaryClient.getMainHost()).state;
      const legacy = await oldClient();
      try {
        await expect(
          legacy.setMainHost({
            mainHost: secondary.serverId,
            expectedGeneration: 6,
            requestId: "old-client-refused",
          }),
        ).rejects.toThrow("Update this client and host to use Main host");
      } finally {
        await legacy.close();
      }
      expect((await primaryClient.getMainHost()).state).toEqual(before);
      await withoutMainCapability(page);
      await page.reload();
      await expect(page.getByTestId("main-host-read-error").first()).toContainText(
        "Update this client and host to use Main host",
      );
      await page.screenshot({ path: testInfo.outputPath("main-old-client-refusal-1440.png") });
      expect((await primaryClient.getMainHost()).state).toEqual(before);
      expect((await secondaryClient.getMainHost()).state.choice).toEqual(before.choice);
      await testInfo.attach("final-main-state", {
        body: JSON.stringify(before, null, 2),
        contentType: "application/json",
      });
    });
  } finally {
    await closeObserver();
    for (const cleanup of projectCleanups.toReversed()) await cleanup();
    await primaryClient.close();
    await secondaryClient.close();
    await secondary.close();
    await rm(secondaryHome, { recursive: true, force: true });
  }
});

test("Loading Main disables confirmation and Retry preserves the setting until a read succeeds", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const release = await holdMainReads(page);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "main-loading" });
  try {
    const before = (await client.getMainHost()).state;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/open-project");
    await expect(page.getByTestId("main-host-status")).toContainText("Checking Main host");
    await expect(page.getByRole("button", { name: "Retry host settings" })).toBeVisible();
    await expect(
      page.getByTestId(`make-main-${(await client.getMainHost()).allocator.serverId}`),
    ).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("main-loading-390.png") });
    expect((await client.getMainHost()).state).toEqual(before);
    await page.getByRole("button", { name: "Retry host settings" }).click();
    release();
    await expect(page.getByTestId("main-host-status")).not.toContainText("Checking Main host");
    expect((await client.getMainHost()).state).toEqual(before);
  } finally {
    await client.close();
  }
});

test("An unreachable saved host keeps Settings reachable while Main is unknown", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "offline-main-startup",
  });
  try {
    const before = (await client.getMainHost()).state;
    await page.routeWebSocket(wsRoutePatternForPort(getE2EDaemonPort()), async (socket) => {
      await socket.close({ code: 1008, reason: "The saved host is unreachable." });
    });
    await page.setViewportSize({ width: 1440, height: 940 });
    await page.goto("/");
    const settings = page.getByTestId("sidebar-settings");
    await expect(settings).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("main-offline-startup-1440.png") });
    await settings.click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    expect((await client.getMainHost()).state).toEqual(before);
  } finally {
    await client.close();
  }
});

for (const variant of ["old-host", "read-only"] as const) {
  test(`${variant} hides Main mutation actions and keeps the previous setting`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const frames = await loadSessionMessageReaders();
    let writes = 0;
    await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
      const server = browser.connectToServer();
      browser.onMessage((frame) => {
        const type = frames.client(frame)?.type;
        if (type === "fleet.main_host.set.request" || type === "fleet.main_host.apply.request")
          writes++;
        server.send(frame);
      });
      server.onMessage((frame) => {
        const envelope = JSON.parse(frame.toString());
        const payload = (envelope.message ?? envelope).payload;
        if (payload?.status === "server_info") {
          if (variant === "old-host") delete payload.features.mainHost;
          else payload.permissions = ["daemon.read"];
        }
        browser.send(JSON.stringify(envelope));
      });
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: variant });
    try {
      const current = (await client.getMainHost()).state;
      if (variant === "read-only") {
        await client.setMainHost({
          mainHost: "other-saved-host",
          expectedGeneration: current.choice?.generation ?? 0,
          requestId: "permission-hidden-held-choice",
        });
      }
      const before: MainHostState = (await client.getMainHost()).state;
      await page.goto("/open-project");
      await expect(page.getByTestId("main-host-status")).toBeVisible();
      await expect(page.getByTestId(/^make-main-/)).toHaveCount(0);
      await expect(page.getByTestId("deliver-main-host")).toHaveCount(0);
      await expect(page.getByTestId("undo-main-host")).toHaveCount(0);
      if (variant === "old-host")
        await expect(page.getByTestId("main-host-status")).toContainText(
          "Update localhost to use Main host",
        );
      expect(writes).toBe(0);
      expect((await client.getMainHost()).state).toEqual(before);
    } finally {
      await client.close();
    }
  });
}

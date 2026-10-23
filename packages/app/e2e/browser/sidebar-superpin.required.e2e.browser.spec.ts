import { test, expect, type Page } from "../support/fixtures";
import type { TestInfo, WebSocketRoute } from "@playwright/test";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  openSidebarDisplayPage,
  openMobileAgentSidebar,
  expectMobileAgentSidebarVisible,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";
import {
  readReplicaCache,
  waitForWorkspaceInReplicaCache,
} from "../support/helpers/replica-cache-storage";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const RPC = "workspace.superpin.set.request";
const RESPONSE = "workspace.superpin.set.response";
const key = (id: string) => `${getServerId()}:${id}`;
const rowID = (id: string) => `sidebar-workspace-row-${key(id)}`;
const row = (page: Page, id: string) => page.getByTestId(rowID(id));
const top = (page: Page) => page.getByTestId("sidebar-superpinned-section");
const pinned = (page: Page) => page.getByTestId("sidebar-pinned-section");
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600;
async function showSidebar(page: Page) {
  if (narrow(page)) {
    // A closing drawer can still contain a visible close button. Wait for the whole
    // panel to settle before deciding whether it needs opening again.
    let settled = "moving";
    await expect
      .poll(async () => {
        const box = await page.getByTestId("sidebar-sessions").boundingBox();
        const width = page.viewportSize()!.width;
        if (!box || box.x + box.width <= 0 || box.x >= width) settled = "closed";
        else if (box.x >= 0 && box.x + box.width <= width) settled = "open";
        else settled = "moving";
        return settled;
      })
      .not.toBe("moving");
    if (settled === "closed") await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
  }
}
async function openRowMenu(page: Page, id: string) {
  await showSidebar(page);
  await expect(row(page, id)).toBeVisible({ timeout: 30_000 });
  await row(page, id).hover();
  await page.getByTestId(`sidebar-workspace-kebab-${key(id)}`).click();
}
async function rowAction(page: Page, id: string, action: "superpin" | "pin") {
  await openRowMenu(page, id);
  const item = page.getByTestId(`sidebar-workspace-menu-${action}-${key(id)}`);
  await expect(item).toBeVisible();
  await item.click();
}
async function dismissOverlay(page: Page) {
  const backdrop = page.getByRole("button", { name: "Bottom sheet backdrop", exact: true });
  // A workspace moving sections can close its sheet between observation and click.
  // Retry that whole operation, bounded, and require the dismissal postcondition.
  await expect(async () => {
    if (narrow(page) && (await backdrop.count()) > 0)
      await backdrop.click({ position: { x: 8, y: 8 }, timeout: 500 });
    else await page.keyboard.press("Escape");
    await expect(backdrop).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 5_000, intervals: [100, 250, 500] });
}
async function waitForPinSettled(page: Page, seed: SeededWorkspace, isPinned: boolean) {
  await openWorkspace(page, seed);
  await page
    .getByTestId(`workspace-deck-entry-${key(seed.workspaceId)}`)
    .getByTestId("workspace-header-menu-trigger")
    .click();
  const pin = page.getByTestId(`workspace-header-pin-${key(seed.workspaceId)}`);
  await expect(pin).toHaveText(isPinned ? "Unpin" : "Pin to top");
  // Pin and Superpin share pending state, cleared only after the app settles its RPC.
  await expect(pin).toBeEnabled();
  await dismissOverlay(page);
}
async function readState(seed: SeededWorkspace) {
  const workspace = (await seed.client.fetchWorkspaces()).entries.find(
    (w) => w.id === seed.workspaceId,
  );
  if (!workspace) throw new Error("Seeded workspace missing from independent daemon read");
  return { pinnedAt: workspace.pinnedAt, superpinnedAt: workspace.superpinnedAt };
}
async function capture(page: Page, info: TestInfo, name: string) {
  if (
    narrow(page) &&
    [
      "superpinned-project",
      "superpinned-status",
      "superpinned-cache-reopen",
      "superpin-refused",
    ].includes(name)
  ) {
    await expect(page.getByText("Workspace actions", { exact: true })).not.toBeInViewport();
  }
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width - 10, viewport.height - 10);
  await expect(page.getByTestId("workspace-hover-card")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}
async function openWorkspace(page: Page, seed: SeededWorkspace) {
  await showSidebar(page);
  await row(page, seed.workspaceId).click();
  await expect(
    page
      .getByTestId(`workspace-deck-entry-${key(seed.workspaceId)}`)
      .getByTestId("workspace-header-title"),
  ).toBeVisible();
}
async function palette(page: Page, title: string) {
  if (narrow(page)) {
    // Compact web intentionally disables global shortcuts; selection still uses the keyboard.
    await showSidebar(page);
    await page.getByTestId("sidebar-search").click();
  } else {
    await page.keyboard.press("ControlOrMeta+K");
  }
  const panel = page.getByTestId("command-center-panel");
  await expect(panel).toBeVisible();
  const input = panel.getByTestId("command-center-input");
  await input.fill(title);
  return { panel, input, action: panel.getByRole("button", { name: title, exact: true }) };
}
async function installFaults(page: Page) {
  const state = { stripCapability: false, dropServerInfo: false, denyNext: false, requests: 0 };
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    sockets.add(browser);
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      const envelope = JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8"));
      const request = envelope.type === "session" ? envelope.message : null;
      if (request?.type === RPC) {
        state.requests++;
        if (state.denyNext) {
          state.denyNext = false;
          browser.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId: request.requestId,
                  requestType: RPC,
                  error: "Superpin rejected by test.",
                  code: "transport",
                },
              },
            }),
          );
          return;
        }
      }
      server.send(frame);
    });
    server.onMessage((frame) => {
      const envelope = JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8"));
      const message = envelope.message ?? envelope;
      if (
        state.dropServerInfo &&
        message.type === "status" &&
        message.payload?.status === "server_info"
      )
        return;
      if (
        state.stripCapability &&
        message.type === "status" &&
        message.payload?.status === "server_info"
      )
        delete message.payload.features.workspaceSuperpinning;
      browser.send(JSON.stringify(envelope));
    });
  });
  return {
    state,
    disconnect: async () => {
      for (const socket of sockets)
        await socket.close({ code: 1008, reason: "Superpin reconnect test" });
      sockets.clear();
    },
  };
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}x${viewport.height} web Superpinned`, () => {
    test.use({ viewport });
    test("3fdb71dd-7bc7-81c1-8df8-e1a11aa86938@0b7e04dd45da#unique-section 3fdb71dd-7bc7-816a-bca8-cefc13498226@2467ee223467#row-menu 3fdb71dd-7bc7-81ea-9aa3-fc216379b35c@dbb8cee69f7e#remove 3fdb71dd-7bc7-8115-aae9-d4ae7eebc644@3075d2001db6#unpin 3fdb71dd7bc781c9964de0b6101b4e61@e93b9847d6fd#status-list promote, remove and unpin without duplicates", async ({
      page,
    }, info) => {
      const seed = await seedWorkspace({
        repoPrefix: "superpin-journey-",
        title: "Priority workspace",
      });
      const ordinary = await seedWorkspace({
        repoPrefix: "superpin-ordinary-",
        title: "Ordinary pin",
      });
      try {
        await ordinary.client.setWorkspacePinned(ordinary.workspaceId, true);
        await gotoAppShell(page);
        await rowAction(page, seed.workspaceId, "superpin");
        await expect(top(page).getByTestId(rowID(seed.workspaceId))).toBeVisible();
        await expect(row(page, seed.workspaceId)).toHaveCount(1);
        await expect(pinned(page).getByTestId(rowID(seed.workspaceId))).toHaveCount(0);
        await expect(
          page
            .locator('[data-testid^="sidebar-project-workspaces-"]')
            .getByTestId(rowID(seed.workspaceId)),
        ).toHaveCount(0);
        const state = await readState(seed);
        expect(state.pinnedAt).toEqual(expect.any(String));
        expect(state.superpinnedAt).toEqual(expect.any(String));
        expect((await top(page).boundingBox())!.y).toBeLessThan(
          (await pinned(page).boundingBox())!.y,
        );
        await capture(page, info, "superpinned-project");
        await waitForPinSettled(page, seed, true);
        await page.reload();
        await showSidebar(page);
        await expect(top(page).getByTestId(rowID(seed.workspaceId))).toBeVisible();
        expect(await readState(seed)).toEqual(state);
        await openRowMenu(page, seed.workspaceId);
        await expect(
          page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`),
        ).toHaveText("Remove superpin");
        await expect(
          page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`),
        ).toBeInViewport({ ratio: 1 });
        await capture(page, info, "superpinned-menu");
        await page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`).click();
        await expect(pinned(page).getByTestId(rowID(seed.workspaceId))).toBeVisible();
        expect(await readState(seed)).toEqual({ pinnedAt: state.pinnedAt, superpinnedAt: null });
        await rowAction(page, seed.workspaceId, "superpin");
        await expect(top(page)).toBeVisible();
        await selectSidebarStatusGrouping(page);
        await expect(page.getByTestId("sidebar-status-list-scroll")).toBeVisible();
        await expect(top(page).getByTestId(rowID(seed.workspaceId))).toBeVisible();
        await expect(row(page, seed.workspaceId)).toHaveCount(1);
        await expect(
          page
            .locator('[data-testid^="sidebar-status-group-rows-"]')
            .getByTestId(rowID(seed.workspaceId)),
        ).toHaveCount(0);
        expect((await top(page).boundingBox())!.y).toBeLessThan(
          (await pinned(page).boundingBox())!.y,
        );
        await capture(page, info, "superpinned-status");
        await openSidebarDisplayPage(page, "sidebar-display-grouping");
        await page.getByTestId("sidebar-grouping-project").click();
        await rowAction(page, seed.workspaceId, "pin");
        await expect(top(page)).toHaveCount(0);
        await expect(row(page, seed.workspaceId)).toHaveCount(1);
        expect(await readState(seed)).toEqual({ pinnedAt: null, superpinnedAt: null });
        await expect(
          page
            .getByRole("group", { name: seed.projectDisplayName, exact: true })
            .getByTestId(rowID(seed.workspaceId)),
        ).toHaveCount(1);
        if (!narrow(page)) {
          await rowAction(page, seed.workspaceId, "superpin");
          await expect(top(page)).toBeVisible();
          await openWorkspace(page, seed);
          await page.keyboard.press("ControlOrMeta+Shift+P");
          await expect.poll(() => readState(seed)).toEqual({ pinnedAt: null, superpinnedAt: null });
          await showSidebar(page);
          await expect(row(page, seed.workspaceId)).toHaveCount(1);
        }
      } finally {
        await seed.cleanup();
        await ordinary.cleanup();
      }
    });

    test("3fdb71dd-7bc7-819c-a877-cd75ea604d90@4f2db58109a2#order 3fdb71dd-7bc7-8193-83f6-cc37ba6c9dd9@0a9e62e2a465#web-reload 3fdb71dd7bc781c9964de0b6101b4e61@e93b9847d6fd#replica-cache ignores saved pin order and reopens from persisted cache", async ({
      page,
    }, info) => {
      const first = await seedWorkspace({
        repoPrefix: "superpin-order-a-",
        title: "A older priority",
      });
      const second = await seedWorkspace({
        repoPrefix: "superpin-order-b-",
        title: "Z newest priority",
      });
      try {
        const gate = await installDaemonWebSocketGate(page);
        await first.client.setWorkspacePinned(first.workspaceId, true);
        await second.client.setWorkspacePinned(second.workspaceId, true);
        await first.client.setWorkspacePinPlacement({
          workspaceId: first.workspaceId,
          placement: { parentWorkspaceKey: null, siblingOrder: 1024 },
          expectedRevision: 0,
        });
        await second.client.setWorkspacePinPlacement({
          workspaceId: second.workspaceId,
          placement: { parentWorkspaceKey: null, siblingOrder: 0 },
          expectedRevision: 0,
        });
        await gotoAppShell(page);
        await showSidebar(page);
        await expect(pinned(page)).toBeVisible();
        const saved = [key(first.workspaceId), key(second.workspaceId)];
        await page.evaluate(
          (order) =>
            localStorage.setItem(
              "sidebar-project-workspace-order",
              JSON.stringify({
                state: { pinnedWorkspaceOrder: order, pinnedWorkspaceSortMode: "manual" },
                version: 2,
              }),
            ),
          saved,
        );
        await page.reload();
        await showSidebar(page);
        await expect(
          pinned(page).locator('[data-testid^="sidebar-workspace-row-"]').first(),
        ).toHaveAttribute("data-testid", rowID(second.workspaceId));
        await rowAction(page, first.workspaceId, "superpin");
        await expect(top(page)).toBeVisible();
        await rowAction(page, second.workspaceId, "superpin");
        await expect(top(page).locator('[data-testid^="sidebar-workspace-row-"]')).toHaveCount(2);
        await expect(
          top(page).locator('[data-testid^="sidebar-workspace-row-"]').first(),
        ).toHaveAttribute("data-testid", rowID(second.workspaceId));
        await expect(top(page).getByTestId("sidebar-pinned-sort")).toHaveCount(0);
        const before = await readState(second);
        expect(Date.parse(before.superpinnedAt!)).toBeGreaterThan(
          Date.parse((await readState(first)).superpinnedAt!),
        );
        await waitForWorkspaceInReplicaCache(page, second.workspaceId);
        await expect
          .poll(() => cachedSuperpin(page, second.workspaceId))
          .toBe(before.superpinnedAt);
        await waitForPinSettled(page, first, true);
        await waitForPinSettled(page, second, true);
        gate.setServerMessageSuppressed("fetch_workspaces_response", true);
        gate.setServerMessageSuppressed("workspace_update", true);
        await page.reload();
        await showSidebar(page);
        await expect(top(page).getByTestId(rowID(second.workspaceId))).toBeVisible();
        await expect(
          top(page).locator('[data-testid^="sidebar-workspace-row-"]').first(),
        ).toHaveAttribute("data-testid", rowID(second.workspaceId));
        await capture(page, info, "superpinned-cache-reopen");
        expect(await readState(second)).toEqual(before);
        gate.setServerMessageSuppressed("fetch_workspaces_response", false);
        gate.setServerMessageSuppressed("workspace_update", false);
      } finally {
        await first.cleanup();
        await second.cleanup();
      }
    });

    test("3fdb71dd-7bc7-816a-bca8-cefc13498226@2467ee223467#command-center toggles both states from the keyboard", async ({
      page,
    }) => {
      const seed = await seedWorkspace({ repoPrefix: "superpin-command-" });
      try {
        await gotoAppShell(page);
        await openWorkspace(page, seed);
        const promote = await palette(page, "Superpin");
        await expect(promote.action).toBeVisible();
        await promote.input.press("Enter");
        await expect.poll(async () => Boolean((await readState(seed)).superpinnedAt)).toBe(true);
        const remove = await palette(page, "Remove superpin");
        await expect(remove.action).toBeVisible();
        await remove.input.press("Enter");
        await expect.poll(async () => (await readState(seed)).superpinnedAt).toBeNull();
        expect((await readState(seed)).pinnedAt).toEqual(expect.any(String));
      } finally {
        await seed.cleanup();
      }
    });

    test("3fdb71dd-7bc7-8140-810e-e7cd4f4539b5@999c2120aca7#denied preserves confirmed state and retries after refusal", async ({
      page,
    }, info) => {
      const seed = await seedWorkspace({ repoPrefix: "superpin-denied-" });
      try {
        const faults = await installFaults(page);
        faults.state.denyNext = true;
        const before = await readState(seed);
        await gotoAppShell(page);
        await rowAction(page, seed.workspaceId, "superpin");
        await expect(page.getByTestId("app-toast-message")).toContainText(
          "Superpin rejected by test.",
        );
        await expect(top(page)).toHaveCount(0);
        expect(await readState(seed)).toEqual(before);
        if (!narrow(page)) {
          // Menu focus restoration may open a late hover card after the pointer has left.
          await row(page, seed.workspaceId).hover();
          await expect(page.getByTestId("workspace-hover-card")).toBeVisible();
          await dismissOverlay(page);
        }
        await capture(page, info, "superpin-refused");
        await rowAction(page, seed.workspaceId, "superpin");
        await expect(top(page)).toBeVisible();
        expect((await readState(seed)).superpinnedAt).toEqual(expect.any(String));
        expect(faults.state.requests).toBe(2);
      } finally {
        await seed.cleanup();
      }
    });

    test("3fdb71dd-7bc7-81fe-9280-c37f47c8e4b9@c0b2fb81314b#old-daemon hides all entry points while server info is unknown", async ({
      page,
    }, info) => {
      test.setTimeout(150_000);
      const plain = await seedWorkspace({
        repoPrefix: "superpin-unknown-plain-",
        title: "Unknown host ordinary workspace",
      });
      const priority = await seedWorkspace({
        repoPrefix: "superpin-unknown-priority-",
        title: "Unknown host priority workspace",
      });
      try {
        const faults = await installFaults(page);
        await priority.client.setWorkspaceSuperpinned(priority.workspaceId, true);
        const before = [await readState(plain), await readState(priority)];
        await gotoAppShell(page);
        await openWorkspace(page, plain);
        for (const seed of [plain, priority])
          await waitForWorkspaceInReplicaCache(page, seed.workspaceId);
        await expect
          .poll(() => cachedSuperpin(page, priority.workspaceId))
          .toBe(before[1].superpinnedAt);
        faults.state.dropServerInfo = true;
        await page.reload();
        for (const seed of [plain, priority]) {
          await assertUnknownHost(
            page,
            seed,
            info,
            `unknown-${seed === plain ? "ordinary" : "priority"}`,
          );
          await showSidebar(page);
          await expect(row(page, seed.workspaceId)).toHaveCount(1);
        }
        expect([await readState(plain), await readState(priority)]).toEqual(before);
        expect(faults.state.requests).toBe(0);
      } finally {
        await plain.cleanup();
        await priority.cleanup();
      }
    });

    test("3fdb71dd-7bc7-81fe-9280-c37f47c8e4b9@c0b2fb81314b#old-daemon hides all entry points initially and after reconnect downgrade", async ({
      page,
    }, info) => {
      const seed = await seedWorkspace({ repoPrefix: "superpin-old-host-" });
      try {
        const faults = await installFaults(page);
        faults.state.stripCapability = true;
        await gotoAppShell(page);
        await assertOldHost(page, seed, info, "old-daemon");
        faults.state.stripCapability = false;
        await faults.disconnect();
        await expect.poll(() => countRowSuperpin(page, seed.workspaceId)).toBe(1);
        await assertCapableHost(page, seed, info);
        faults.state.stripCapability = true;
        await faults.disconnect();
        // Last-known support is retained while disconnected. Wait for the new
        // handshake to remove the action from an actually mounted menu.
        await expect.poll(() => countRowSuperpin(page, seed.workspaceId)).toBe(0);
        await assertOldHost(page, seed, info, "downgraded-daemon");
        await expect(
          page.getByTestId("app-toast-message").filter({ hasText: "Update the host" }),
        ).toHaveCount(0);
      } finally {
        await seed.cleanup();
      }
    });

    test("3fdb71dd-7bc7-8140-810e-e7cd4f4539b5@999c2120aca7#timeout dropped response reads back before another mutation", async ({
      page,
    }, info) => {
      test.setTimeout(150_000);
      const seed = await seedWorkspace({ repoPrefix: "superpin-lost-reply-" });
      try {
        const gate = await installDaemonWebSocketGate(page);
        await gotoAppShell(page);
        await showSidebar(page);
        await expect(row(page, seed.workspaceId)).toBeVisible();
        gate.setServerMessageSuppressed(RESPONSE, true);
        gate.holdNextClientRequest("fetch_workspaces_request");
        await rowAction(page, seed.workspaceId, "superpin");
        await gate.waitForHeldClientRequest();
        await expect(page.getByTestId("app-toast-message")).toContainText("Outcome unknown");
        await openRowMenu(page, seed.workspaceId);
        await expect(
          page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`),
        ).toHaveAttribute("aria-disabled", "true");
        await capture(page, info, "superpin-unknown-pending");
        expect(gate.getClientRequestCount(RPC)).toBe(1);
        const confirmed = await readState(seed);
        expect(confirmed.superpinnedAt).toEqual(expect.any(String));
        gate.releaseHeldClientRequest();
        gate.setServerMessageSuppressed(RESPONSE, false);
        await expect(
          page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`),
        ).not.toHaveAttribute("aria-disabled", "true");
        expect(gate.getClientRequestCount(RPC)).toBe(1);
        expect(await readState(seed)).toEqual(confirmed);
      } finally {
        await seed.cleanup();
      }
    });

    test("3fdb71dd-7bc7-8140-810e-e7cd4f4539b5@999c2120aca7#timeout disconnect reconciles before explicit retry", async ({
      page,
    }) => {
      const seed = await seedWorkspace({ repoPrefix: "superpin-disconnect-" });
      try {
        const gate = await installDaemonWebSocketGate(page);
        await gotoAppShell(page);
        await showSidebar(page);
        await expect(row(page, seed.workspaceId)).toBeVisible();
        gate.holdNextClientRequest(RPC);
        await rowAction(page, seed.workspaceId, "superpin");
        await gate.waitForHeldClientRequest();
        await gate.drop();
        await expect(page.getByTestId("app-toast-message")).toContainText("Outcome unknown");
        expect(await readState(seed)).toEqual({ pinnedAt: null, superpinnedAt: null });
        await openRowMenu(page, seed.workspaceId);
        await expect(
          page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`),
        ).toHaveAttribute("aria-disabled", "true");
        await dismissOverlay(page);
        gate.holdNextClientRequest("fetch_workspaces_request");
        gate.restore();
        await gate.waitForHeldClientRequest();
        // Hold both the live directory subscription and the mutation's read-back.
        // Releasing only the read-back would let retry succeed without live updates.
        await expect
          .poll(() => {
            const modes = new Set<string>();
            for (const request of gate.getHeldClientRequests()) {
              if (request)
                modes.add(request.subscribe === undefined ? "read-back" : "subscription");
            }
            return [...modes].sort();
          })
          .toEqual(["read-back", "subscription"]);
        await openRowMenu(page, seed.workspaceId);
        const retry = page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`);
        await expect(retry).toHaveAttribute("aria-disabled", "true");
        gate.releaseHeldClientRequest();
        await expect(retry).not.toHaveAttribute("aria-disabled", "true");
        await retry.click();
        await expect(top(page)).toBeVisible();
        expect(gate.getClientRequestCount(RPC)).toBe(2);
        expect((await readState(seed)).superpinnedAt).toEqual(expect.any(String));
      } finally {
        await seed.cleanup();
      }
    });
  });
}

async function countRowSuperpin(page: Page, workspaceId: string) {
  await openRowMenu(page, workspaceId);
  await expect(
    page.getByTestId(`sidebar-workspace-menu-labels-${key(workspaceId)}`),
  ).toBeInViewport({ ratio: 1 });
  const count = await page
    .getByTestId(`sidebar-workspace-menu-superpin-${key(workspaceId)}`)
    .count();
  await dismissOverlay(page);
  return count;
}

async function assertOldHost(
  page: Page,
  seed: SeededWorkspace,
  info: TestInfo,
  captureName: string,
) {
  await openRowMenu(page, seed.workspaceId);
  await expect(
    page.getByTestId(`sidebar-workspace-menu-labels-${key(seed.workspaceId)}`),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`sidebar-workspace-menu-pin-${key(seed.workspaceId)}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`sidebar-workspace-menu-pin-${key(seed.workspaceId)}`),
  ).toBeInViewport({ ratio: 1 });
  await capture(page, info, `${captureName}-row`);
  await page.getByTestId(`sidebar-workspace-menu-pin-${key(seed.workspaceId)}`).click();
  await openWorkspace(page, seed);
  await page
    .getByTestId(`workspace-deck-entry-${key(seed.workspaceId)}`)
    .getByTestId("workspace-header-menu-trigger")
    .click();
  await expect(page.getByTestId(`workspace-header-labels-${key(seed.workspaceId)}`)).toBeInViewport(
    { ratio: 1 },
  );
  await expect(page.getByTestId(`workspace-header-superpin-${key(seed.workspaceId)}`)).toHaveCount(
    0,
  );
  await expect(page.getByTestId(`workspace-header-pin-${key(seed.workspaceId)}`)).toBeInViewport({
    ratio: 1,
  });
  await capture(page, info, `${captureName}-header`);
  await dismissOverlay(page);
  const command = await palette(page, "Rename workspace");
  await expect(command.action).toBeVisible();
  await command.input.fill("Superpin");
  await expect(
    command.panel.getByRole("button", { name: /^(Superpin|Remove superpin)$/ }),
  ).toHaveCount(0);
  await expect(command.panel.getByTestId("command-center-file-search-loading")).toHaveCount(0);
  if (narrow(page)) await expect(page.getByTestId("sidebar-sessions")).not.toBeInViewport();
  await capture(page, info, `${captureName}-command-center`);
  await dismissOverlay(page);
  const before = await readState(seed);
  if (narrow(page)) await rowAction(page, seed.workspaceId, "pin");
  else await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect
    .poll(async () => Boolean((await readState(seed)).pinnedAt))
    .toBe(before.pinnedAt == null);
  expect((await readState(seed)).superpinnedAt).toBeNull();
  await waitForPinSettled(page, seed, before.pinnedAt == null);
}

async function cachedSuperpin(page: Page, workspaceId: string) {
  const cache = await readReplicaCache(page);
  const workspaces = cache?.hosts?.flatMap((host) => host.workspaces);
  return workspaces?.find((workspace) => workspace.id === workspaceId)?.superpinnedAt;
}

async function assertUnknownHost(page: Page, seed: SeededWorkspace, info: TestInfo, name: string) {
  await openRowMenu(page, seed.workspaceId);
  await expect(
    page.getByTestId(`sidebar-workspace-menu-labels-${key(seed.workspaceId)}`),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`),
  ).toHaveCount(0);
  await capture(page, info, `${name}-row`);
  await dismissOverlay(page);
  await openWorkspace(page, seed);
  await page
    .getByTestId(`workspace-deck-entry-${key(seed.workspaceId)}`)
    .getByTestId("workspace-header-menu-trigger")
    .click();
  await expect(page.getByTestId(`workspace-header-labels-${key(seed.workspaceId)}`)).toBeInViewport(
    { ratio: 1 },
  );
  await expect(page.getByTestId(`workspace-header-superpin-${key(seed.workspaceId)}`)).toHaveCount(
    0,
  );
  await capture(page, info, `${name}-header`);
  await dismissOverlay(page);
  const command = await palette(page, "Rename workspace");
  await expect(command.action).toBeVisible();
  await command.input.fill("Superpin");
  await expect(
    command.panel.getByRole("button", { name: /^(Superpin|Remove superpin)$/ }),
  ).toHaveCount(0);
  await expect(command.panel.getByTestId("command-center-file-search-loading")).toHaveCount(0);
  if (narrow(page)) await expect(page.getByTestId("sidebar-sessions")).not.toBeInViewport();
  await capture(page, info, `${name}-command-center`);
  await dismissOverlay(page);
}

async function assertCapableHost(page: Page, seed: SeededWorkspace, info: TestInfo) {
  await openRowMenu(page, seed.workspaceId);
  await expect(
    page.getByTestId(`sidebar-workspace-menu-superpin-${key(seed.workspaceId)}`),
  ).toBeInViewport({ ratio: 1 });
  await capture(page, info, "capable-row");
  await dismissOverlay(page);
  await openWorkspace(page, seed);
  await page
    .getByTestId(`workspace-deck-entry-${key(seed.workspaceId)}`)
    .getByTestId("workspace-header-menu-trigger")
    .click();
  await expect(
    page.getByTestId(`workspace-header-superpin-${key(seed.workspaceId)}`),
  ).toBeInViewport({ ratio: 1 });
  await capture(page, info, "capable-header");
  await dismissOverlay(page);
  const command = await palette(page, "Superpin");
  await expect(command.action).toBeVisible();
  await capture(page, info, "capable-command-center");
  await dismissOverlay(page);
}

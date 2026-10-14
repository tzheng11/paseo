import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";

test.use({
  video: {
    mode: process.env.E2E_RECORD_VIDEO === "1" ? "on" : "retain-on-failure",
    size: { width: 1440, height: 900 },
  },
});

test("fixed Info fields save, reload, cancel, clear, merge, retry and recover conflicts", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await seedWorkspace({
    repoPrefix: "workspace-info-",
    title: "Workspace Info demo",
  });
  const b = await seedWorkspace({
    repoPrefix: "workspace-info-other-",
    title: "Independent workspace",
  });
  const field = (key: string) =>
    page.getByTestId(`workspace-info-field-${key}`).filter({ visible: true });
  const value = (key: string) =>
    page.getByTestId(`workspace-info-value-${key}`).filter({ visible: true });
  const input = () => page.getByTestId("workspace-info-input").filter({ visible: true });
  const save = () => page.getByTestId("workspace-info-save").filter({ visible: true });
  const cancel = () => page.getByTestId("workspace-info-cancel").filter({ visible: true });
  const open = async (id: string) => {
    await gotoWorkspace(page, id);
    await ensureExplorerSidebar(page);
    await page.getByTestId("workspace-tab-info").filter({ visible: true }).click();
    await expect(
      page.getByTestId("workspace-info-availability").filter({ visible: true }),
    ).toHaveCount(0);
  };
  const screenshot = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  try {
    await open(workspace.workspaceId);
    await expect(field("notionProjectUrl")).toContainText("Notion Project URL");
    await expect(field("notionIssueUrl")).toContainText("Notion Issue URL");
    await expect(value("notionProjectUrl")).toHaveText("Empty");
    await expect(value("notionIssueUrl")).toHaveText("Empty");
    const rows = page.locator('[data-testid^="workspace-info-field-"]').filter({ visible: true });
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute(
      "data-testid",
      "workspace-info-field-notionProjectUrl",
    );
    await screenshot("empty-desktop");
    if (process.env.E2E_RECORD_VIDEO === "1") await page.waitForTimeout(700);
    await field("notionProjectUrl").click();
    await input().fill("https://www.notion.so/project-demo");
    await screenshot("editing-desktop");
    if (process.env.E2E_RECORD_VIDEO === "1") await page.waitForTimeout(700);
    gate.holdNextServerMessage("workspace.field.value.set.response");
    await save().click();
    await gate.waitForHeldServerMessage("workspace.field.value.set.response");
    await expect(save()).toBeDisabled();
    await expect(save()).toContainText("Saving");
    await screenshot("pending-desktop");
    gate.releaseHeldServerMessage("workspace.field.value.set.response");
    await expect(value("notionProjectUrl")).toHaveText("https://www.notion.so/project-demo");
    await expect(input()).toHaveCount(0);
    const literal = "https://www.notion.so/issue-demo\n<strong>literal field text</strong>";
    await field("notionIssueUrl").click();
    await input().fill(literal);
    await save().click();
    await expect(value("notionIssueUrl")).toHaveText(literal);
    await page.reload();
    await open(workspace.workspaceId);
    await expect(value("notionProjectUrl")).toHaveText("https://www.notion.so/project-demo");
    await expect(value("notionIssueUrl")).toHaveText(literal);
    await screenshot("populated-desktop");
    if (process.env.E2E_RECORD_VIDEO === "1") await page.waitForTimeout(700);
    const persisted = (await workspace.client.fetchWorkspaces()).entries.find(
      (w) => w.id === workspace.workspaceId,
    )?.fieldValues;
    expect(persisted).toEqual({
      notionProjectUrl: "https://www.notion.so/project-demo",
      notionIssueUrl: literal,
    });
    await field("notionProjectUrl").click();
    await input().fill("discard this");
    await cancel().click();
    await expect(value("notionProjectUrl")).toHaveText(persisted!.notionProjectUrl);
    await field("notionProjectUrl").click();
    await input().fill("my draft");
    await workspace.client.setWorkspaceFieldValue({
      workspaceId: workspace.workspaceId,
      fieldKey: "notionProjectUrl",
      expectedValue: persisted!.notionProjectUrl,
      value: "another client",
    });
    await save().click();
    await expect(page.getByTestId("workspace-info-error").filter({ visible: true })).toContainText(
      "Cancel and reopen",
    );
    await expect(input()).toHaveValue("my draft");
    await screenshot("conflict-desktop");
    await cancel().click();
    await field("notionProjectUrl").click();
    await expect(input()).toHaveValue("another client");
    await input().fill("");
    await save().click();
    await expect(value("notionProjectUrl")).toHaveText("Empty");
    await expect(value("notionIssueUrl")).toHaveText(literal);
    expect(
      (await workspace.client.fetchWorkspaces()).entries.find((w) => w.id === workspace.workspaceId)
        ?.fieldValues,
    ).toEqual({ notionProjectUrl: "", notionIssueUrl: literal });
    await workspace.client.setWorkspaceFieldValue({
      workspaceId: workspace.workspaceId,
      fieldKey: "notionProjectUrl",
      expectedValue: "",
      value: "☃".repeat(8000),
    });
    await field("notionIssueUrl").click();
    await input().fill("☃".repeat(8000));
    await save().click();
    await expect(page.getByTestId("workspace-info-error").filter({ visible: true })).toContainText(
      "too large",
    );
    await expect(input()).toHaveValue("☃".repeat(8000));
    await screenshot("error-desktop");
    await input().fill("Short enough");
    await save().click();
    await expect(value("notionIssueUrl")).toHaveText("Short enough");
    await field("notionIssueUrl").click();
    await input().fill("Draft survives disconnect");
    await gate.drop();
    await expect(
      page.getByTestId("workspace-info-availability").filter({ visible: true }),
    ).toContainText("disconnected");
    await save().click();
    await expect(page.getByTestId("workspace-info-error").filter({ visible: true })).toContainText(
      "disconnected",
    );
    await expect(input()).toHaveValue("Draft survives disconnect");
    await screenshot("offline-desktop");
    gate.restore();
    await expect(
      page.getByTestId("workspace-info-availability").filter({ visible: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    await save().click();
    await expect(value("notionIssueUrl")).toHaveText("Draft survives disconnect");
    await open(b.workspaceId);
    await expect(value("notionProjectUrl")).toHaveText("Empty");
    await expect(value("notionIssueUrl")).toHaveText("Empty");
    await open(workspace.workspaceId);
    await expect(value("notionIssueUrl")).toHaveText("Draft survives disconnect");
    await page
      .getByTestId("workspace-tab-info")
      .filter({ visible: true })
      .click({ button: "right" });
    await expect(page.getByTestId("workspace-tab-context-info-close")).toBeDisabled();
    await page.keyboard.press("Escape");
  } finally {
    gate.restore();
    await b.cleanup();
    await workspace.cleanup();
  }
});

test("compact non-git workspace supports both fields and keyboard editing without clipping", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = await seedWorkspace({ repoPrefix: "workspace-info-nongit-", git: false });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).click();
    await page.getByTestId("explorer-tab-info").filter({ visible: true }).click();
    const content = page.getByTestId("workspace-info-content").filter({ visible: true });
    await expect(content).toBeVisible();
    await expect(
      page.getByTestId("workspace-info-value-notionProjectUrl").filter({ visible: true }),
    ).toHaveText("Empty");
    await page.getByTestId("workspace-info-field-notionIssueUrl").filter({ visible: true }).click();
    const input = page.getByTestId("workspace-info-input").filter({ visible: true });
    await expect(input).toBeFocused();
    await page.keyboard.type("https://www.notion.so/compact-issue");
    await expect(input).toHaveValue("https://www.notion.so/compact-issue");
    await page.screenshot({ path: testInfo.outputPath("compact-editing.png") });
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("workspace-info-save").filter({ visible: true })).toBeFocused();
    await page.getByTestId("workspace-info-save").filter({ visible: true }).press("Enter");
    await expect(
      page.getByTestId("workspace-info-value-notionIssueUrl").filter({ visible: true }),
    ).toHaveText("https://www.notion.so/compact-issue");
    for (const row of await content.locator('[data-testid^="workspace-info-field-"]').all()) {
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    }
    const path = testInfo.outputPath("compact-nongit.png");
    await page.screenshot({ path });
    await testInfo.attach("compact-nongit", { path, contentType: "image/png" });
  } finally {
    await workspace.cleanup();
  }
});

test("legacy layouts gain permanent Info once, preserving Files selection; dark keyboard editing works", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await seedWorkspace({ repoPrefix: "workspace-info-legacy-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await ensureExplorerSidebar(page);
    await page.getByTestId("workspace-tab-files").filter({ visible: true }).click();
    await page.evaluate(() => {
      const raw = localStorage.getItem("workspace-layout-state");
      if (!raw) throw new Error("Missing persisted workspace layout");
      const stored = JSON.parse(raw);
      const walk = (node: {
        kind: string;
        pane?: {
          tabs: { target: { kind: string }; tabId: string }[];
          tabIds: string[];
          focusedTabId: string;
        };
        group?: { children: unknown[] };
      }) => {
        if (node.pane) {
          node.pane.tabs = node.pane.tabs.filter((tab) => tab.target.kind !== "info");
          node.pane.tabIds = node.pane.tabs.map((tab) => tab.tabId);
          if (node.pane.tabIds.includes("files")) node.pane.focusedTabId = "files";
        }
        for (const child of node.group?.children ?? []) walk(child as Parameters<typeof walk>[0]);
      };
      for (const layout of Object.values(stored.state.layoutByWorkspace) as {
        root: Parameters<typeof walk>[0];
      }[])
        walk(layout.root);
      localStorage.setItem("workspace-layout-state", JSON.stringify(stored));
      const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ ...settings, theme: "dark" }));
    });
    await page.reload();
    await ensureExplorerSidebar(page);
    await expect(page.getByTestId("workspace-tab-info").filter({ visible: true })).toHaveCount(1);
    await expect(page.getByTestId("workspace-tab-files").filter({ visible: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.reload();
    await ensureExplorerSidebar(page);
    await expect(page.getByTestId("workspace-tab-info").filter({ visible: true })).toHaveCount(1);
    await expect(page.getByTestId("workspace-tab-files").filter({ visible: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByTestId("workspace-tab-info").filter({ visible: true }).click();
    await page
      .getByTestId("workspace-info-field-notionProjectUrl")
      .filter({ visible: true })
      .click();
    const input = page.getByTestId("workspace-info-input").filter({ visible: true });
    await expect(input).toBeFocused();
    await page.keyboard.type("https://www.notion.so/keyboard-project");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("workspace-info-save").filter({ visible: true })).toBeFocused();
    const editingPath = testInfo.outputPath("dark-keyboard-editing.png");
    await page.screenshot({ path: editingPath });
    await testInfo.attach("dark-keyboard-editing", { path: editingPath, contentType: "image/png" });
    await page.keyboard.press("Enter");
    await expect(
      page.getByTestId("workspace-info-value-notionProjectUrl").filter({ visible: true }),
    ).toHaveText("https://www.notion.so/keyboard-project");
    await page
      .getByTestId("workspace-tab-files")
      .filter({ visible: true })
      .click({ button: "right" });
    await page.getByTestId("workspace-tab-context-files-close-others").click();
    await expect(page.getByTestId("workspace-tab-info").filter({ visible: true })).toHaveCount(1);
    await page.getByTestId("workspace-tab-info").filter({ visible: true }).click();
    const path = testInfo.outputPath("dark-populated.png");
    await page.screenshot({ path });
    await testInfo.attach("dark-populated", { path, contentType: "image/png" });
  } finally {
    await workspace.cleanup();
  }
});

test("a delayed save acknowledgement preserves a newer second-client value", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await seedWorkspace({ repoPrefix: "workspace-info-delayed-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await ensureExplorerSidebar(page);
    await page.getByTestId("workspace-tab-info").filter({ visible: true }).click();
    await page
      .getByTestId("workspace-info-field-notionProjectUrl")
      .filter({ visible: true })
      .click();
    await page.getByTestId("workspace-info-input").filter({ visible: true }).fill("first-save");
    gate.holdNextServerMessage("workspace.field.value.set.response");
    await page.getByTestId("workspace-info-save").filter({ visible: true }).click();
    await gate.waitForHeldServerMessage("workspace.field.value.set.response");
    await workspace.client.setWorkspaceFieldValue({
      workspaceId: workspace.workspaceId,
      fieldKey: "notionProjectUrl",
      expectedValue: "first-save",
      value: "newer-second-client",
    });
    const value = page
      .getByTestId("workspace-info-value-notionProjectUrl")
      .filter({ visible: true });
    await expect(value).toHaveText("newer-second-client");
    gate.releaseHeldServerMessage("workspace.field.value.set.response");
    await expect(page.getByTestId("workspace-info-input").filter({ visible: true })).toHaveCount(0);
    await expect(value).toHaveText("newer-second-client");
    expect(
      (await workspace.client.fetchWorkspaces()).entries.find((w) => w.id === workspace.workspaceId)
        ?.fieldValues?.notionProjectUrl,
    ).toBe("newer-second-client");
    const path = testInfo.outputPath("delayed-ack-latest-value.png");
    await page.screenshot({ path });
    await testInfo.attach("delayed-ack-latest-value", { path, contentType: "image/png" });
  } finally {
    gate.restore();
    await workspace.cleanup();
  }
});

for (const variant of ["v0.11.2-omitted-feature", "version-2", "read-only", "hub-only"] as const) {
  test(`${variant} capability fixture shows fixed labels and prevents mutations`, async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: `workspace-info-${variant}-` });
    let mutations = 0;
    await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
      const server = browser.connectToServer();
      browser.onMessage((message) => {
        const envelope = JSON.parse(message.toString());
        if ((envelope.message ?? envelope).type === "workspace.field.value.set.request")
          mutations++;
        server.send(message);
      });
      server.onMessage((message) => {
        const envelope = JSON.parse(message.toString());
        const payload = (envelope.message ?? envelope).payload as
          | ServerInfoStatusPayload
          | undefined;
        if (payload?.status === "server_info") {
          if (variant === "v0.11.2-omitted-feature") {
            if (payload.features) delete payload.features.workspaceFields;
            delete payload.workspaceFieldCatalogVersion;
          } else if (variant === "version-2") payload.workspaceFieldCatalogVersion = 2;
          else payload.permissions = variant === "read-only" ? ["workspace.read"] : ["hub.execute"];
        }
        browser.send(JSON.stringify(envelope));
      });
    });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await ensureExplorerSidebar(page);
      await page.getByTestId("workspace-tab-info").filter({ visible: true }).click();
      const update = variant === "v0.11.2-omitted-feature" || variant === "version-2";
      await expect(
        page.getByTestId("workspace-info-availability").filter({ visible: true }),
      ).toHaveText(
        update
          ? "Update this host to edit workspace fields."
          : "You have read-only access to these fields.",
      );
      for (const [key, label] of [
        ["notionProjectUrl", "Notion Project URL"],
        ["notionIssueUrl", "Notion Issue URL"],
      ]) {
        const row = page.getByTestId(`workspace-info-field-${key}`).filter({ visible: true });
        await expect(row).toContainText(label);
        await expect(row).toBeDisabled();
        await expect(
          page.getByTestId(`workspace-info-value-${key}`).filter({ visible: true }),
        ).toHaveText(update ? "Unavailable" : "Empty");
      }
      await expect(page.getByTestId("workspace-info-input").filter({ visible: true })).toHaveCount(
        0,
      );
      expect(mutations).toBe(0);
      expect(
        (await workspace.client.fetchWorkspaces()).entries.find(
          (w) => w.id === workspace.workspaceId,
        )?.fieldValues,
      ).toEqual({});
      const path = testInfo.outputPath(`${variant}.png`);
      await page.screenshot({ path });
      await testInfo.attach(variant, { path, contentType: "image/png" });
    } finally {
      await workspace.cleanup();
    }
  });
}

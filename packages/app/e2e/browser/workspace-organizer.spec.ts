import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { openSidebarDisplayPage, selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import { organizationSchema } from "../../../../plugin-examples/workspace-organizer/shared/organization";

const pluginId = "workspace-organizer";
const sidebarPrefix = `plugin-sidebar-${pluginId}-organization`;
const readSchema = z.object({
  status: z.literal("ready"),
  revision: z.string(),
  values: organizationSchema,
});
async function createFolder(page: Page, title: string) {
  await page.getByRole("textbox", { name: "Folder name", exact: true }).fill(title);
  await page.getByRole("button", { name: "Create folder", exact: true }).click();
  await expect(page.getByRole("button", { name: `Edit ${title}`, exact: true })).toBeVisible();
}
async function selectParent(page: Page, label: "Add inside" | "Inside folder", title: string) {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
  await page.getByRole("menuitem", { name: title, exact: true }).click();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByTestId("organizer-editor")).toHaveCount(0);
}
async function preserveRegistry(page: Page) {
  await page.evaluate(() =>
    localStorage.setItem(
      "@paseo:e2e-disable-default-seed-once",
      localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
    ),
  );
}

test("pinned folders contain cross-host workspace leaves, share links/order and protect drafts", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-organizer-"));
  const primary = await connectNewWorkspaceDaemonClient();
  const secondary = await startIsolatedHostDaemon("organizer-secondary");
  const remote = await connectNewWorkspaceDaemonClient({
    port: secondary.port,
    ownProjects: false,
  });
  const previous = await primary.getDaemonConfig();
  const example = await copyPluginExample("workspace-organizer");
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  const read = async () =>
    readSchema.parse(await primary.invokePluginRpc(pluginId, "settings.organization.read", {}));
  try {
    await mkdir(path.join(directory, "Studio-workspace"));
    await mkdir(path.join(directory, "Laptop-workspace"));
    const studioWorkspace = await openProjectViaDaemon(
      primary,
      path.join(directory, "Studio-workspace"),
    );
    const laptopWorkspace = await openProjectViaDaemon(
      remote,
      path.join(directory, "Laptop-workspace"),
    );
    await primary.setWorkspacePinned(studioWorkspace.workspaceId, true);
    await primary.patchDaemonConfig({ pluginsEnabled: true });
    await primary.installDirectoryPlugin(example.directory);
    expect((await remote.getDaemonConfig()).config.pluginsEnabled ?? false).toBe(false);
    await gotoAppShell(page);
    await addConnectedHostAndReload(page, {
      serverId: secondary.serverId,
      label: "Laptop",
      port: secondary.port,
      primaryLabel: "Studio",
    });
    await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
    await expect(
      page.getByTestId("sidebar-pinned-plugin-items").getByTestId(`${sidebarPrefix}-manage`),
    ).toHaveCount(1);
    await page.getByTestId(`${sidebarPrefix}-manage`).click();
    await createFolder(page, "Hyperbola");
    await createFolder(page, "Other projects");
    await selectParent(page, "Add inside", "Hyperbola");
    await createFolder(page, "Development");
    await selectParent(page, "Add inside", "Development");
    await page
      .getByRole("button", {
        name: `Add ${studioWorkspace.workspaceName} from Studio`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: `Edit ${studioWorkspace.workspaceName}`, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Add inside:/ }).click();
    await expect(
      page.getByRole("menuitem", { name: studioWorkspace.workspaceName, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Development", exact: true }).click();
    await page
      .getByRole("button", {
        name: `Add ${laptopWorkspace.workspaceName} from Laptop`,
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: `Edit ${laptopWorkspace.workspaceName}`, exact: true })
      .click();
    await page.getByRole("textbox", { name: "Link name", exact: true }).fill("Notion project");
    await page
      .getByRole("textbox", { name: "Project URL", exact: true })
      .fill("https://www.notion.so/hyperbola-project");
    await page.getByRole("button", { name: "Add link to draft", exact: true }).click();
    await save(page);
    await page.getByRole("button", { name: "Edit Development", exact: true }).click();
    await page.getByRole("button", { name: /^Inside folder:/ }).click();
    await expect(
      page.getByRole("menuitem", { name: studioWorkspace.workspaceName, exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Development", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Hyperbola", exact: true }).click();
    await page.getByRole("textbox", { name: "Link name", exact: true }).fill("Project overview");
    await page
      .getByRole("textbox", { name: "Project URL", exact: true })
      .fill("https://www.notion.so/hyperbola-overview");
    await page.getByRole("button", { name: "Add link to draft", exact: true }).click();
    await save(page);
    const initial = await read();
    const folder = initial.values.nodes.find((node) => node.title === "Hyperbola")!;
    const development = initial.values.nodes.find((node) => node.title === "Development")!;
    const studio = initial.values.nodes.find(
      (node) => node.kind === "workspace" && node.workspaceId === studioWorkspace.workspaceId,
    )!;
    const laptop = initial.values.nodes.find(
      (node) => node.kind === "workspace" && node.workspaceId === laptopWorkspace.workspaceId,
    )!;
    expect(development.parentId).toBe(folder.id);
    expect(studio.parentId).toBe(development.id);
    expect(laptop.parentId).toBe(development.id);
    expect(development.links[0].url).toBe("https://www.notion.so/hyperbola-overview");
    // Folder clicks only expand/collapse; workspace rows navigate.
    const editorUrl = page.url();
    await page.getByTestId(`${sidebarPrefix}-node-${development.id}`).click();
    await expect(page.getByTestId(`${sidebarPrefix}-node-${laptop.id}`)).toHaveCount(0);
    await expect(page).toHaveURL(editorUrl);
    await page.getByTestId(`${sidebarPrefix}-node-${development.id}`).click();
    await expect(page.getByTestId(`${sidebarPrefix}-node-${laptop.id}`)).toBeVisible();
    await expect(
      page.getByTestId(`${sidebarPrefix}-link-${development.id}-${development.links[0].id}`),
    ).toBeVisible();
    expect(laptop.links[0].url).toBe("https://www.notion.so/hyperbola-project");
    // Separate storage and WebSocket connection, as on another device.
    peerContext = await browser.newContext({ storageState: await page.context().storageState() });
    const peer = await peerContext.newPage();
    await peer.goto(page.url());
    await expect(
      peer.getByRole("button", { name: `Edit ${laptopWorkspace.workspaceName}`, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit Hyperbola", exact: true }).click();
    await page.getByRole("textbox", { name: "Entry name", exact: true }).fill("Unsaved draft");
    await peer.getByRole("button", { name: "Edit Other projects", exact: true }).click();
    await peer.getByRole("button", { name: "Move up", exact: true }).click();
    await save(peer);
    await expect
      .poll(async () =>
        (await read()).values.nodes
          .filter((node) => node.parentId === null)
          .map((node) => node.title),
      )
      .toEqual(["Other projects", "Hyperbola"]);
    await expect(page.getByRole("button", { name: /^Edit / }).first()).toHaveAccessibleName(
      "Edit Other projects",
    );
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText(/Settings changed on another client/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Entry name", exact: true })).toHaveValue(
      "Unsaved draft",
    );
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    const saved = await read();
    const stored = z
      .object({ version: z.literal(2), values: organizationSchema })
      .parse(
        JSON.parse(
          await readFile(
            path.join(
              process.env.E2E_PASEO_HOME!,
              "plugin-settings",
              pluginId,
              "organization.json",
            ),
            "utf8",
          ),
        ),
      );
    expect(stored.values).toEqual(saved.values);
    await primary.reloadPlugin(pluginId);
    await preserveRegistry(page);
    await page.reload();
    await expect(
      page.getByTestId(`${sidebarPrefix}-link-${laptop.id}-${laptop.links[0].id}`),
    ).toBeVisible();
    expect((await read()).values).toEqual(saved.values);
    await page.screenshot({ path: test.info().outputPath("organization-wide.png") });
    const regularPinId = `sidebar-workspace-row-${studio.kind === "workspace" ? studio.serverId : ""}:${studioWorkspace.workspaceId}`;
    await expect(
      page.getByTestId("sidebar-pinned-section").getByTestId(regularPinId),
    ).toBeVisible();
    await selectSidebarStatusGrouping(page);
    await expect(page.getByTestId("sidebar-status-list-scroll")).toBeVisible();
    await expect(
      page
        .getByTestId("sidebar-pinned-plugin-items")
        .getByTestId(`${sidebarPrefix}-node-${laptop.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId("sidebar-pinned-section").getByTestId(regularPinId),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("organization-grouped.png") });
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-project").click();
    await page
      .context()
      .route("https://www.notion.so/hyperbola-project", (route) =>
        route.fulfill({ contentType: "text/html", body: "Test project" }),
      );
    const opened = page.context().waitForEvent("page");
    await page.getByTestId(`${sidebarPrefix}-link-${laptop.id}-${laptop.links[0].id}`).click();
    const projectPage = await opened;
    await expect(projectPage).toHaveURL("https://www.notion.so/hyperbola-project");
    await projectPage.close();
    await page.getByTestId("sidebar-pinned-section-header").click();
    await expect(page.getByTestId(`${sidebarPrefix}-manage`)).toHaveCount(0);
    await page.getByTestId("sidebar-pinned-section-header").click();
    await page.getByTestId(`${sidebarPrefix}-node-${laptop.id}`).click();
    await expectAppRoute(
      page,
      buildHostWorkspaceRoute(secondary.serverId, laptopWorkspace.workspaceId),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("menu-button").filter({ visible: true }).first().click();
    await expect(page.getByTestId(`${sidebarPrefix}-node-${laptop.id}`)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("organization-compact.png") });
    await page.getByTestId(`${sidebarPrefix}-node-${studio.id}`).click();
    await expectAppRoute(
      page,
      buildHostWorkspaceRoute(
        studio.kind === "workspace" ? studio.serverId : "",
        studioWorkspace.workspaceId,
      ),
    );
    await expect(page.getByTestId(`${sidebarPrefix}-manage`)).not.toBeVisible();
    await secondary.close();
    await page.getByTestId("menu-button").filter({ visible: true }).first().click();
    await expect(page.getByText("Laptop · offline", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId(`${sidebarPrefix}-node-${laptop.id}`).click();
    await expect(
      page.getByText("Laptop is offline. The workspace remains linked.", { exact: true }),
    ).toBeVisible();
    await page.getByTestId(`${sidebarPrefix}-manage`).click();
    await page.getByRole("button", { name: "Edit Development", exact: true }).click();
    await page.getByRole("button", { name: "Remove folder", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit Development", exact: true })).toHaveCount(
      0,
    );
    const promoted = await read();
    expect(promoted.values.nodes.find((node) => node.id === studio.id)?.parentId).toBe(folder.id);
    expect(promoted.values.nodes.find((node) => node.id === laptop.id)?.parentId).toBe(folder.id);
    await page
      .getByRole("button", { name: `Edit ${studioWorkspace.workspaceName}`, exact: true })
      .click();
    await page.getByRole("button", { name: "Unpin workspace", exact: true }).click();
    await expect(
      page.getByRole("button", { name: `Edit ${studioWorkspace.workspaceName}`, exact: true }),
    ).toHaveCount(0);
    const remaining = (await primary.fetchWorkspaces()).entries.find(
      (entry) => entry.id === studioWorkspace.workspaceId,
    );
    expect(remaining?.pinnedAt).toEqual(expect.any(String));
  } finally {
    await peerContext?.close();
    await remote.close();
    await secondary.close();
    await primary.removePlugin(pluginId);
    await primary.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await primary.close();
    await example.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

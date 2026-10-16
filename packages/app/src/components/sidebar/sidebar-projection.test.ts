import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function workspaceIds(workspaces: readonly SidebarWorkspacePlacement[]): string[] {
  return workspaces.map((workspace) => workspace.workspaceId);
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
    t: i18n.t,
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  for (const groupMode of ["project", "status"] as const) {
    it(`sorts pinned display names naturally and keeps ${groupMode} shortcuts in the same order`, () => {
      const workspaces = [makeWorkspace("z"), makeWorkspace("a10"), makeWorkspace("a2")];
      workspaces[0]!.entry.name = "Zeta";
      workspaces[1]!.entry.name = "alpha 10";
      workspaces[2]!.entry.name = "Alpha 2";
      const input = {
        ...projectionInput({ groupMode }),
        projects: [makeProject(workspaces.map((workspace) => workspace.placement))],
        pinnedKeys: {
          pinnedWorkspaceKeys: workspaces.map((workspace) => workspace.placement.workspaceKey),
          pinnedAtByKey: {},
        },
        pinnedWorkspaceOrder: workspaces.map((workspace) => workspace.placement.workspaceKey),
        workspaceEntriesByKey: new Map(workspaces.map(({ entry }) => [entry.workspaceKey, entry])),
      };
      const alphabetical = buildSidebarProjection({
        ...input,
        pinnedWorkspaceSortMode: "alphabetical",
      });
      expect(
        alphabetical.pinnedGroups.pinnedChats.map((workspace) => workspace.workspaceId),
      ).toEqual(["a2", "a10", "z"]);
      expect(
        alphabetical.shortcutModel.shortcutTargets.map((workspace) => workspace.workspaceId),
      ).toEqual(["a2", "a10", "z"]);
      expect(
        buildSidebarProjection({
          ...input,
          pinnedWorkspaceSortMode: "manual",
        }).pinnedGroups.pinnedChats.map((workspace) => workspace.workspaceId),
      ).toEqual(["z", "a10", "a2"]);

      const renamed = workspaces[0]!.entry;
      input.workspaceEntriesByKey.set(renamed.workspaceKey, { ...renamed, name: "Aardvark" });
      expect(
        buildSidebarProjection({ ...input, pinnedWorkspaceSortMode: "alphabetical" }).pinnedGroups
          .pinnedChats[0]?.workspaceId,
      ).toBe("z");
    });
  }

  it("sorts by the visible branch label and falls back to the workspace name", () => {
    const first = makeWorkspace("one");
    const second = makeWorkspace("two");
    first.entry.name = "Alpha";
    first.entry.currentBranch = "zeta-branch";
    second.entry.name = "Beta";
    const input = {
      ...projectionInput(),
      projects: [makeProject([first.placement, second.placement])],
      pinnedKeys: {
        pinnedWorkspaceKeys: [first.placement.workspaceKey, second.placement.workspaceKey],
        pinnedAtByKey: {},
      },
      workspaceEntriesByKey: new Map(
        [first.entry, second.entry].map((entry) => [entry.workspaceKey, entry]),
      ),
      pinnedWorkspaceSortMode: "alphabetical" as const,
    };
    expect(
      buildSidebarProjection({ ...input, workspaceTitleSource: "title" }).pinnedGroups
        .pinnedChats[0]?.workspaceId,
    ).toBe("one");
    expect(
      buildSidebarProjection({ ...input, workspaceTitleSource: "branch" }).pinnedGroups
        .pinnedChats[0]?.workspaceId,
    ).toBe("two");
  });

  it("sorts each project independently without changing Pinned or manual placement order", () => {
    const first = [makeWorkspace("z"), makeWorkspace("a")];
    const second = [
      makeWorkspace("y", "done", [], "other"),
      makeWorkspace("b", "done", [], "other"),
    ];
    const pinned = makeWorkspace("pinned");
    const input = {
      ...projectionInput(),
      projects: [
        makeProject([pinned.placement, ...first.map(({ placement }) => placement)]),
        makeProject(
          second.map(({ placement }) => placement),
          "other",
        ),
      ],
      workspaceEntriesByKey: new Map(
        [pinned, ...first, ...second].map(({ entry }) => [entry.workspaceKey, entry]),
      ),
      workspaceSortModeByProject: { project: "alphabetical" as const },
    };
    const sorted = buildSidebarProjection(input);
    expect(
      sorted.pinnedGroups.unpinnedProjects.map((project) => workspaceIds(project.workspaces)),
    ).toEqual([
      ["a", "z"],
      ["y", "b"],
    ]);
    expect(sorted.shortcutModel.shortcutTargets.map((workspace) => workspace.workspaceId)).toEqual([
      "pinned",
      "a",
      "z",
      "y",
      "b",
    ]);
    const manual = buildSidebarProjection({
      ...input,
      workspaceSortModeByProject: { project: "manual" },
    });
    expect(
      manual.pinnedGroups.unpinnedProjects[0]?.workspaces.map((workspace) => workspace.workspaceId),
    ).toEqual(["z", "a"]);
    expect(input.projects[0]?.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "pinned",
      "z",
      "a",
    ]);
  });

  it("uses displayed branch names for project A–Z sorting", () => {
    const first = makeWorkspace("alpha");
    const second = makeWorkspace("beta");
    first.entry.currentBranch = "zeta";
    const input = {
      ...projectionInput(),
      projects: [makeProject([first.placement, second.placement])],
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      workspaceEntriesByKey: new Map(
        [first, second].map(({ entry }) => [entry.workspaceKey, entry]),
      ),
      workspaceSortModeByProject: { project: "alphabetical" as const },
      workspaceTitleSource: "branch" as const,
    };
    const projection = buildSidebarProjection(input);
    expect(
      projection.pinnedGroups.unpinnedProjects[0]?.workspaces.map(
        (workspace) => workspace.workspaceId,
      ),
    ).toEqual(["beta", "alpha"]);
    expect(
      projection.shortcutModel.shortcutTargets.map((workspace) => workspace.workspaceId),
    ).toEqual(["beta", "alpha"]);
  });

  it("keeps project and Pinned Last Activity order aligned with shortcuts after an update", () => {
    const older = makeWorkspace("older");
    const newer = makeWorkspace("newer");
    const pinnedOlder = makeWorkspace("pinned-older");
    const pinnedNewer = makeWorkspace("pinned-newer");
    older.entry.statusEnteredAt = new Date("2026-10-16T10:00:00Z");
    newer.entry.statusEnteredAt = new Date("2026-10-16T11:00:00Z");
    pinnedOlder.entry.statusEnteredAt = new Date("2026-10-16T09:00:00Z");
    pinnedNewer.entry.statusEnteredAt = new Date("2026-10-16T12:00:00Z");
    const workspaces = [older, newer, pinnedOlder, pinnedNewer];
    const input = {
      ...projectionInput(),
      projects: [makeProject(workspaces.map(({ placement }) => placement))],
      pinnedKeys: {
        pinnedWorkspaceKeys: [
          pinnedOlder.placement.workspaceKey,
          pinnedNewer.placement.workspaceKey,
        ],
        pinnedAtByKey: {},
      },
      workspaceEntriesByKey: new Map(workspaces.map(({ entry }) => [entry.workspaceKey, entry])),
      workspaceSortModeByProject: { project: "activity" as const },
      pinnedWorkspaceSortMode: "activity" as const,
    };
    const projection = buildSidebarProjection(input);
    expect(workspaceIds(projection.pinnedGroups.pinnedChats)).toEqual([
      "pinned-newer",
      "pinned-older",
    ]);
    expect(workspaceIds(projection.pinnedGroups.unpinnedProjects[0]!.workspaces)).toEqual([
      "newer",
      "older",
    ]);
    expect(
      projection.shortcutModel.shortcutTargets.map((workspace) => workspace.workspaceId),
    ).toEqual(["pinned-newer", "pinned-older", "newer", "older"]);
    input.workspaceEntriesByKey.set(older.entry.workspaceKey, {
      ...older.entry,
      statusEnteredAt: new Date("2026-10-16T13:00:00Z"),
    });
    const updated = buildSidebarProjection(input);
    expect(workspaceIds(updated.pinnedGroups.unpinnedProjects[0]!.workspaces)).toEqual([
      "older",
      "newer",
    ]);
    expect(updated.shortcutModel.shortcutTargets.map((workspace) => workspace.workspaceId)).toEqual(
      ["pinned-newer", "pinned-older", "older", "newer"],
    );
  });

  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });
});

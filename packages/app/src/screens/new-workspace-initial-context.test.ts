import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import {
  resolveNewWorkspaceAutomaticServerId,
  resolveNewWorkspaceInitialServerId,
} from "./new-workspace-initial-context";
import {
  buildChildWorkspacePlacement,
  openWorkspaceParentSelection,
  type WorkspaceParentEntry,
  workspaceParentRevealKeys,
} from "./new-workspace/parent-selection";

function parentEntry(overrides: Partial<WorkspaceParentEntry> = {}): WorkspaceParentEntry {
  return {
    workspaceKey: "parent-host:parent",
    workspaceId: "parent",
    projectViewKey: "project",
    serverId: "parent-host",
    name: "Parent",
    projectName: "Project",
    archivingAt: null,
    pinnedAt: null,
    superpinnedAt: null,
    ...overrides,
  };
}

describe("new workspace parent selection", () => {
  it("keeps human New workspace at the root until a parent is selected", () => {
    const model = openWorkspaceParentSelection();
    model.applyCatalog([parentEntry()]);
    expect(model.getState()).toEqual({ workspaceKey: null, display: null });
    expect(
      buildChildWorkspacePlacement({ parentWorkspaceKey: null, workspaces: [] }),
    ).toBeUndefined();
  });

  it("resolves a routed parent after hydration and keeps its display through catalog churn", () => {
    const model = openWorkspaceParentSelection("parent-host:parent");
    model.applyCatalog([]);
    model.applyCatalog([parentEntry()]);
    model.applyCatalog([parentEntry({ name: "Renamed elsewhere" })]);
    model.applyCatalog([]);
    expect(model.getState()).toEqual({ workspaceKey: "parent-host:parent", display: "Parent" });
    model.select(null);
    model.applyCatalog([parentEntry()]);
    expect(model.getState()).toEqual({ workspaceKey: null, display: null });
  });

  it.each(["unpinned", "pinned", "superpinned"] as const)(
    "appends a cross-host child in the parent's %s section after every existing sibling",
    (section) => {
      const flags = {
        pinnedAt: section === "unpinned" ? null : "2026-10-22T00:00:00Z",
        superpinnedAt: section === "superpinned" ? "2026-10-22T00:00:00Z" : null,
      };
      const parent = parentEntry(flags);
      const child = parentEntry({
        ...flags,
        workspaceKey: "other-host:child",
        serverId: "other-host",
        pinPlacement: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 8192, revision: 1 },
      });
      const anotherSection = parentEntry({
        workspaceKey: "another:child",
        pinnedAt: section === "unpinned" ? "now" : null,
        pinPlacement: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 99999, revision: 1 },
      });
      expect(
        buildChildWorkspacePlacement({
          parentWorkspaceKey: parent.workspaceKey,
          workspaces: [parent, child, anotherSection],
        }),
      ).toEqual({ parentWorkspaceKey: parent.workspaceKey, siblingOrder: 9216, section });
    },
  );

  it("does not silently create a root when the selected parent is removed", () => {
    expect(() =>
      buildChildWorkspacePlacement({ parentWorkspaceKey: "gone:parent", workspaces: [] }),
    ).toThrow("Parent workspace is no longer available");
  });

  it("appends after legacy same-project children before their first universal placement", () => {
    const parent = parentEntry();
    const child = parentEntry({
      workspaceKey: "parent-host:old-child",
      workspaceId: "old-child",
      parentWorkspaceId: parent.workspaceId,
      siblingOrder: 8192,
    });
    expect(
      buildChildWorkspacePlacement({
        parentWorkspaceKey: parent.workspaceKey,
        workspaces: [parent, child],
      }),
    ).toEqual({ parentWorkspaceKey: parent.workspaceKey, siblingOrder: 9216, section: "unpinned" });
    expect([
      ...workspaceParentRevealKeys({
        parentWorkspaceKey: child.workspaceKey,
        section: "unpinned",
        workspaces: [parent, child],
      }),
    ]).toEqual([child.workspaceKey, parent.workspaceKey]);
  });

  it("reveals only the selected parent's same-section ancestor chain", () => {
    const parent = parentEntry({
      pinnedAt: "now",
      pinPlacement: {
        parentWorkspaceKey: "ancestor:one",
        siblingOrder: 1,
        revision: 1,
      },
    });
    const ancestor = parentEntry({
      workspaceKey: "ancestor:one",
      pinnedAt: "now",
      pinPlacement: { parentWorkspaceKey: "different:section", siblingOrder: 1, revision: 1 },
    });
    const differentSection = parentEntry({ workspaceKey: "different:section" });
    expect([
      ...workspaceParentRevealKeys({
        parentWorkspaceKey: parent.workspaceKey,
        section: "pinned",
        workspaces: [
          parent,
          ancestor,
          differentSection,
          parentEntry({ workspaceKey: "unrelated:one" }),
        ],
      }),
    ]).toEqual([parent.workspaceKey, ancestor.workspaceKey]);
  });
});

function projectFor(serverId: string, key = "project"): HostProjectListItem {
  return {
    viewKey: `view:${serverId}:${key}`,
    projectKey: key,
    projectName: key,
    projectKind: "git",
    iconWorkingDir: `/work/${key}`,
    hosts: [
      {
        serverId,
        projectId: key,
        iconWorkingDir: `/work/${key}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaceKeys: [],
  };
}

function statuses(
  entries: Record<string, HostRuntimeConnectionStatus>,
): ReadonlyMap<string, HostRuntimeConnectionStatus> {
  return new Map(Object.entries(entries));
}

function multiplicity(entries: Record<string, boolean> = {}): ReadonlyMap<string, boolean> {
  return new Map(Object.entries(entries));
}

describe("resolveNewWorkspaceInitialServerId", () => {
  it("prefers explicit route host context over online-host fallback", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "online"],
        routeServerId: "offline",
        lastActiveProject: null,
        projects: [projectFor("online")],
        hostConnectionStatusByServerId: statuses({ offline: "offline", online: "online" }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("offline");
  });

  it("prefers the sole online host over a stale offline project", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "online"],
        routeServerId: null,
        lastActiveProject: projectFor("offline"),
        projects: [projectFor("offline")],
        hostConnectionStatusByServerId: statuses({ offline: "offline", online: "online" }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("online");

    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "online"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("online")],
        hostConnectionStatusByServerId: statuses({ offline: "offline", online: "online" }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("online");
  });

  it("uses the last active project when there is no sole online host", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "other"],
        routeServerId: null,
        lastActiveProject: projectFor("offline"),
        projects: [projectFor("offline")],
        hostConnectionStatusByServerId: statuses({ offline: "offline", other: "offline" }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("offline");
  });

  it("prefers a connecting project host over a stale offline last active project", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "connecting"],
        routeServerId: null,
        lastActiveProject: projectFor("offline", "remembered"),
        projects: [projectFor("offline", "remembered"), projectFor("connecting", "current")],
        hostConnectionStatusByServerId: statuses({
          offline: "offline",
          connecting: "connecting",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("connecting");
  });

  it("prefers the online last active project over another hydrated online project", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["host-a", "host-b"],
        routeServerId: null,
        lastActiveProject: projectFor("host-b", "remembered"),
        projects: [projectFor("host-a")],
        hostConnectionStatusByServerId: statuses({
          "host-a": "online",
          "host-b": "online",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("host-b");
  });

  it("falls back to the only online host even before projects have hydrated", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline-a", "online", "offline-b"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [],
        hostConnectionStatusByServerId: statuses({
          "offline-a": "offline",
          online: "online",
          "offline-b": "offline",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("online");
  });

  it("prefers an online host over the only cached offline project", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "online-a", "online-b"],
        routeServerId: null,
        lastActiveProject: projectFor("offline"),
        projects: [projectFor("offline")],
        hostConnectionStatusByServerId: statuses({
          offline: "offline",
          "online-a": "online",
          "online-b": "online",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("online-a");
  });

  it("prefers the first online project host over an empty online host", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["empty-online", "project-online-a", "project-online-b"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("project-online-a", "a"), projectFor("project-online-b", "b")],
        hostConnectionStatusByServerId: statuses({
          "empty-online": "online",
          "project-online-a": "online",
          "project-online-b": "online",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("project-online-a");
  });

  it("uses the only host with selectable projects even before runtime status is online", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "connected"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("connected")],
        hostConnectionStatusByServerId: statuses({
          offline: "offline",
          connected: "connecting",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("connected");
  });
});

describe("resolveNewWorkspaceAutomaticServerId", () => {
  it("keeps a usable automatic host stable when the computed default changes", () => {
    expect(
      resolveNewWorkspaceAutomaticServerId({
        allServerIds: ["host-a", "host-b"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("host-a"), projectFor("host-b")],
        hostConnectionStatusByServerId: statuses({ "host-a": "online", "host-b": "online" }),
        workspaceMultiplicityByServerId: multiplicity(),
        currentServerId: "host-a",
        nextServerId: "host-b",
      }),
    ).toBe("host-a");
  });

  it("switches to the remembered online host after it hydrates", () => {
    expect(
      resolveNewWorkspaceAutomaticServerId({
        allServerIds: ["host-a", "host-b"],
        routeServerId: null,
        lastActiveProject: projectFor("host-b", "remembered"),
        projects: [projectFor("host-a"), projectFor("host-b", "remembered")],
        hostConnectionStatusByServerId: statuses({
          "host-a": "online",
          "host-b": "online",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
        currentServerId: "host-a",
        nextServerId: "host-b",
      }),
    ).toBe("host-b");
  });

  it("switches from an offline automatic host to the online default", () => {
    expect(
      resolveNewWorkspaceAutomaticServerId({
        allServerIds: ["offline", "online"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("offline")],
        hostConnectionStatusByServerId: statuses({ offline: "offline", online: "online" }),
        workspaceMultiplicityByServerId: multiplicity(),
        currentServerId: "offline",
        nextServerId: "online",
      }),
    ).toBe("online");
  });

  it("switches from an offline automatic host to a connecting default with projects", () => {
    expect(
      resolveNewWorkspaceAutomaticServerId({
        allServerIds: ["offline", "connecting"],
        routeServerId: null,
        lastActiveProject: projectFor("offline", "remembered"),
        projects: [projectFor("offline", "remembered"), projectFor("connecting", "current")],
        hostConnectionStatusByServerId: statuses({
          offline: "offline",
          connecting: "connecting",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
        currentServerId: "offline",
        nextServerId: "connecting",
      }),
    ).toBe("connecting");
  });

  it("switches to the default when the current automatic host has no selectable projects", () => {
    expect(
      resolveNewWorkspaceAutomaticServerId({
        allServerIds: ["empty", "with-project"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("with-project")],
        hostConnectionStatusByServerId: statuses({
          empty: "connecting",
          "with-project": "connecting",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
        currentServerId: "empty",
        nextServerId: "with-project",
      }),
    ).toBe("with-project");
  });

  it("does not switch from an online host to an offline cached project", () => {
    expect(
      resolveNewWorkspaceAutomaticServerId({
        allServerIds: ["online-empty", "offline-project"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("offline-project")],
        hostConnectionStatusByServerId: statuses({
          "online-empty": "online",
          "offline-project": "offline",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
        currentServerId: "online-empty",
        nextServerId: "offline-project",
      }),
    ).toBe("online-empty");
  });
});

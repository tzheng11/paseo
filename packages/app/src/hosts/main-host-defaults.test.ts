import { describe, expect, test } from "vitest";
import { resolveStartupRoute } from "@/navigation/host-runtime-bootstrap";
import {
  applyAvailableAddProjectHosts,
  chooseAddProjectHost,
  currentAddProjectPage,
  openAddProjectFlow,
  type AddProjectHost,
} from "@/add-project-flow/model";
import { resolveActiveHostServerId } from "@/types/host-connection";
import { resolveNewWorkspaceInitialServerId } from "@/screens/new-workspace-initial-context";
import type { HostProjectListItem } from "@/projects/host-projects";

const hosts = [{ serverId: "first" }, { serverId: "main" }];
const startup = {
  route: { kind: "index" as const, pathname: "/" },
  startupBlocker: { kind: "none" as const },
  hostRegistryStatus: "ready" as const,
  hosts,
  anyOnlineHostServerId: "first",
  workspaceSelection: null,
  workspaceSelectionStatus: "unknown" as const,
  isWorkspaceSelectionLoaded: true,
  hasGivenUpWaitingForHost: false,
  mainHostServerId: "main",
};

function addHost(serverId: string): AddProjectHost {
  return {
    serverId,
    label: serverId,
    canAddProject: true,
    canBrowse: true,
    canCloneGithubRepositories: true,
    canSearchGithubRepositories: true,
    canCreateDirectory: true,
  };
}

function project(serverId: string): HostProjectListItem {
  return {
    viewKey: `view:${serverId}`,
    projectKey: "project",
    projectName: "project",
    projectKind: "git",
    iconWorkingDir: "/work/project",
    hosts: [
      {
        serverId,
        projectId: "project",
        iconWorkingDir: "/work/project",
        worktreeSupport: "supported",
      },
    ],
    workspaceKeys: [],
  };
}

describe("Main is a default and never replaces an explicit or saved choice", () => {
  test("fresh startup prefers Main without reordering the catalogue", () => {
    expect(resolveStartupRoute(startup)).toEqual({ kind: "redirect", href: "/h/main" });
    expect(hosts.map((host) => host.serverId)).toEqual(["first", "main"]);
  });

  test("startup waits for Main reads, then uses the existing fallback if unset", () => {
    expect(resolveStartupRoute({ ...startup, mainHostLoading: true })).toEqual({ kind: "splash" });
    expect(resolveStartupRoute({ ...startup, mainHostServerId: null })).toEqual({
      kind: "redirect",
      href: "/h/first",
    });
  });

  test("last workspace and explicit routes win even while Main reads load", () => {
    expect(
      resolveStartupRoute({
        ...startup,
        mainHostLoading: true,
        workspaceSelection: { serverId: "first", workspaceId: "saved-workspace" },
      }),
    ).toEqual({ kind: "redirect", href: "/h/first" });
    expect(
      resolveStartupRoute({
        ...startup,
        route: { kind: "index", pathname: "/settings" },
        mainHostLoading: true,
      }),
    ).toEqual({ kind: "render" });
    expect(resolveStartupRoute({ ...startup, route: { kind: "host", serverId: "first" } })).toEqual(
      { kind: "render" },
    );
  });

  test("settings uses Main before local fallback but keeps a selected host", () => {
    const input = {
      mainHostServerId: "main",
      selectedServerId: null,
      localServerId: "first",
      hosts,
      orderedHosts: hosts,
    };
    expect(resolveActiveHostServerId(input)).toBe("main");
    expect(resolveActiveHostServerId({ ...input, selectedServerId: "first" })).toBe("first");
    expect(resolveActiveHostServerId({ ...input, mainHostServerId: "removed" })).toBe("first");
  });

  test("Add Project defaults to Main but explicit host and in-progress picker choices win", () => {
    const addHosts = [addHost("first"), addHost("main")];
    expect(
      currentAddProjectPage(openAddProjectFlow({ hosts: addHosts, mainHostId: "main" })),
    ).toMatchObject({ kind: "method", hostId: "main" });
    expect(
      currentAddProjectPage(
        openAddProjectFlow({ hosts: addHosts, mainHostId: "main", preferredHostId: "first" }),
      ),
    ).toMatchObject({ kind: "method", hostId: "first" });
    const picked = chooseAddProjectHost(openAddProjectFlow({ hosts: addHosts }), "first");
    expect(
      currentAddProjectPage(applyAvailableAddProjectHosts(picked, addHosts, undefined, "main")),
    ).toMatchObject({ kind: "method", hostId: "first" });
  });

  test("new workspace defaults to Main while route and last project keep precedence", () => {
    const input = {
      mainHostServerId: "main",
      allServerIds: ["first", "main"],
      routeServerId: null,
      lastActiveProject: null,
      projects: [project("first"), project("main")],
      hostConnectionStatusByServerId: new Map([
        ["first", "online" as const],
        ["main", "online" as const],
      ]),
      workspaceMultiplicityByServerId: new Map<string, boolean>(),
    };
    expect(resolveNewWorkspaceInitialServerId(input)).toBe("main");
    expect(resolveNewWorkspaceInitialServerId({ ...input, routeServerId: "first" })).toBe("first");
    expect(
      resolveNewWorkspaceInitialServerId({ ...input, lastActiveProject: project("first") }),
    ).toBe("first");
  });
});

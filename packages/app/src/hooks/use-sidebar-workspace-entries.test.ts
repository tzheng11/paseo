import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import {
  areSidebarWorkspaceSessionsEqual,
  selectSidebarWorkspaceSessions,
  type SidebarWorkspaceSession,
} from "./sidebar-workspaces-view-model";

function workspaceMap(): Map<string, WorkspaceDescriptor> {
  return new Map();
}

function activityMap(): Map<string, WorkspaceAgentActivity> {
  return new Map();
}

function sidebarSession(input?: Partial<Omit<SidebarWorkspaceSession, "serverId">>) {
  return {
    agents: input?.agents ?? new Map<string, Agent>(),
    workspaces: input?.workspaces ?? workspaceMap(),
    workspaceAgentActivity: input?.workspaceAgentActivity ?? activityMap(),
  };
}

describe("sidebar workspace session selection", () => {
  it("selects only sessions needed by sidebar placements", () => {
    const hostA = sidebarSession();
    const hostB = sidebarSession();
    const unusedHost = sidebarSession();

    expect(
      selectSidebarWorkspaceSessions(
        {
          "host-a": hostA,
          "host-b": hostB,
          unused: unusedHost,
        },
        ["host-b", "missing", "host-a"],
      ),
    ).toEqual([
      {
        serverId: "host-b",
        agents: hostB.agents,
        workspaces: hostB.workspaces,
        workspaceAgentActivity: hostB.workspaceAgentActivity,
      },
      {
        serverId: "host-a",
        agents: hostA.agents,
        workspaces: hostA.workspaces,
        workspaceAgentActivity: hostA.workspaceAgentActivity,
      },
    ]);
  });

  it("ignores high-frequency session changes outside the sidebar indexes", () => {
    const workspaces = workspaceMap();
    const workspaceAgentActivity = activityMap();
    const agents = new Map<string, Agent>();

    const previous = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaces, workspaceAgentActivity, agents }) },
      ["host-a"],
    );
    const next = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaces, workspaceAgentActivity, agents }) },
      ["host-a"],
    );

    expect(previous).not.toBe(next);
    expect(areSidebarWorkspaceSessionsEqual(previous, next)).toBe(true);
  });

  it("detects changes to a selected workspace or status index", () => {
    const workspaceAgentActivity = activityMap();
    const previous = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaceAgentActivity, workspaces: workspaceMap() }) },
      ["host-a"],
    );
    const next = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaceAgentActivity, workspaces: workspaceMap() }) },
      ["host-a"],
    );

    expect(areSidebarWorkspaceSessionsEqual(previous, next)).toBe(false);
  });

  it("detects agent updates even when workspace and status indexes are unchanged", () => {
    const workspaces = workspaceMap();
    const workspaceAgentActivity = activityMap();
    const previous = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaces, workspaceAgentActivity, agents: new Map() }) },
      ["host-a"],
    );
    const next = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaces, workspaceAgentActivity, agents: new Map() }) },
      ["host-a"],
    );
    expect(areSidebarWorkspaceSessionsEqual(previous, next)).toBe(false);
  });
});

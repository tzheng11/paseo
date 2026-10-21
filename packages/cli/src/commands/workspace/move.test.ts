import { describe, expect, it } from "vitest";
import { resolveWorkspaceMoveDestination } from "./move.js";

describe("workspace move destination", () => {
  it("moves under a parent before a sibling", () => {
    expect(resolveWorkspaceMoveDestination({ parent: "ws-parent", before: "ws-sibling" })).toEqual({
      parentWorkspaceId: "ws-parent",
      beforeWorkspaceId: "ws-sibling",
    });
  });

  it("moves to the project root", () => {
    expect(resolveWorkspaceMoveDestination({ root: true })).toEqual({ parentWorkspaceId: null });
  });

  it("requires an explicit destination", () => {
    expect(() => resolveWorkspaceMoveDestination({})).toThrow();
  });

  it("rejects conflicting destinations", () => {
    expect(() => resolveWorkspaceMoveDestination({ parent: "ws-parent", root: true })).toThrow();
  });

  it("rejects empty destination ids", () => {
    expect(() => resolveWorkspaceMoveDestination({ parent: " " })).toThrow();
    expect(() => resolveWorkspaceMoveDestination({ root: true, before: " " })).toThrow();
  });
});

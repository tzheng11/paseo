import { describe, expect, it } from "vitest";
import { resolveWorkspaceMove } from "./move.js";

describe("workspace move destination", () => {
  it("places a workspace before a sibling under the requested parent", () => {
    expect(resolveWorkspaceMove({ parent: "parent", before: "next" })).toEqual({
      parentWorkspaceId: "parent",
      beforeWorkspaceId: "next",
    });
  });

  it("appends to the project's top level", () => {
    expect(resolveWorkspaceMove({ root: true })).toEqual({ parentWorkspaceId: null });
  });

  it.each([{}, { parent: " " }, { root: true, parent: "parent" }, { root: true, before: " " }])(
    "rejects an ambiguous or empty destination %j",
    (options) => {
      expect(() => resolveWorkspaceMove(options)).toThrow();
    },
  );
});

import { describe, expect, it } from "vitest";

import {
  captureUnmovedProjectOrders,
  hasVisibleOrderChanged,
  mergeWithRemainder,
} from "./sidebar-reorder";

describe("hasVisibleOrderChanged", () => {
  it("returns false when visible order is unchanged", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["a", "b", "c"],
      }),
    ).toBe(false);
  });

  it("returns true when visible items are reordered", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["b", "a", "c"],
      }),
    ).toBe(true);
  });

  it("returns true when a visible key is missing from current order", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b"],
        reorderedVisibleKeys: ["a", "c"],
      }),
    ).toBe(true);
  });
});

describe("mergeWithRemainder", () => {
  it("appends non-visible stored keys after reordered visible keys", () => {
    expect(
      mergeWithRemainder({
        currentOrder: ["a", "x", "b", "y"],
        reorderedVisibleKeys: ["b", "a"],
      }),
    ).toEqual(["b", "a", "x", "y"]);
  });

  it("keeps unknown current keys when no visible keys are reordered", () => {
    expect(
      mergeWithRemainder({
        currentOrder: ["stale", "hidden"],
        reorderedVisibleKeys: [],
      }),
    ).toEqual(["stale", "hidden"]);
  });
});

describe("captureUnmovedProjectOrders", () => {
  const project = (viewKey: string, keys: string[]) => ({
    viewKey,
    workspaces: keys.map((workspaceKey) => ({ workspaceKey })),
  });

  it("keeps another project's displayed order when a drag leaves automatic sorting", () => {
    const previous = { moved: ["h:old", "h:new"], other: [] };
    expect(
      captureUnmovedProjectOrders({
        projects: [project("moved", ["h:new", "h:old"]), project("other", ["h:b", "h:a"])],
        movedProjectViewKey: "moved",
        workspaceOrderByProject: previous,
        workspaceSortModeByProject: {},
      }),
    ).toEqual([{ projectViewKey: "other", order: ["h:b", "h:a"] }]);
    expect(previous).toEqual({ moved: ["h:old", "h:new"], other: [] });
  });

  it("preserves saved manual history, including hidden keys, and automatic project preferences", () => {
    const previous = { manual: ["h:hidden", "h:a", "h:b"] };
    expect(
      captureUnmovedProjectOrders({
        projects: [
          project("manual", ["h:b", "h:a"]),
          project("alphabetical", ["h:alpha", "h:zeta"]),
          project("activity", ["h:recent", "h:old"]),
        ],
        movedProjectViewKey: "moved",
        workspaceOrderByProject: previous,
        workspaceSortModeByProject: { alphabetical: "alphabetical", activity: "activity" },
      }),
    ).toEqual([]);
    expect(previous).toEqual({ manual: ["h:hidden", "h:a", "h:b"] });
  });

  it("captures an explicit Manual project but leaves absent projects and empty groups alone", () => {
    expect(
      captureUnmovedProjectOrders({
        projects: [project("visible", ["h:b", "h:a"]), project("empty", [])],
        movedProjectViewKey: "moved",
        workspaceOrderByProject: { hidden: ["remote:retained"] },
        workspaceSortModeByProject: { visible: "manual" },
      }),
    ).toEqual([{ projectViewKey: "visible", order: ["h:b", "h:a"] }]);
  });
});

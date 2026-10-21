import { describe, expect, it, vi } from "vitest";
import { measureWorkspaceTreeRows } from "./native-geometry";

function row() {
  let callback: ((x: number, y: number, width: number, height: number) => void) | undefined;
  return {
    measureInWindow: (next: NonNullable<typeof callback>) => {
      callback = next;
    },
    finish: (y: number) => callback?.(0, y, 200, 40),
  };
}

describe("native workspace tree geometry", () => {
  it("publishes one complete geometry snapshot per measurement pass", () => {
    const rows = Array.from({ length: 300 }, () => row());
    const nodes = new Map(rows.map((node, index) => [String(index), node]));
    const measured = vi.fn();
    measureWorkspaceTreeRows(nodes, () => true, measured);
    rows.slice(1).forEach((node, index) => node.finish((index + 1) * 40));
    expect(measured).not.toHaveBeenCalled();
    rows[0]!.finish(0);
    expect(measured).toHaveBeenCalledTimes(1);
    expect(measured.mock.calls[0]![0].size).toBe(300);
  });

  it("ignores callbacks after the drag ends, unmounts, or a newer pass has applied", () => {
    const node = row();
    const measured = vi.fn();
    let current = true;
    measureWorkspaceTreeRows(new Map([["row", node]]), () => current, measured);
    current = false;
    node.finish(0);
    expect(measured).not.toHaveBeenCalled();
  });

  it("excludes rows removed or remounted before a pass completes", () => {
    const first = row();
    const second = row();
    const nodes = new Map([
      ["first", first],
      ["second", second],
    ]);
    const measured = vi.fn();
    measureWorkspaceTreeRows(nodes, () => true, measured);
    first.finish(0);
    nodes.set("first", row());
    nodes.delete("second");
    second.finish(40);
    expect(measured).toHaveBeenCalledTimes(1);
    expect(measured.mock.calls[0]![0].size).toBe(0);
  });
});

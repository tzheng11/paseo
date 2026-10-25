import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Page } from "@playwright/test";
import {
  expectStableCommandCenterLayout,
  startCommandCenterLayoutObservation,
} from "../../e2e/support/helpers/command-center-file-search";

const attachments = vi.hoisted(() => ({
  attach: vi.fn(async (_name: string, _options: { body: string; contentType: string }) => {}),
}));
vi.mock("@playwright/test", async () => ({
  expect: (await import("vitest")).expect,
  test: { info: () => attachments },
}));

let dom: JSDOM;
let deliver: (entries: PerformanceEntry[]) => void;
let recordSurfaces: () => void;
const page = {
  evaluate: async (callback: (args: unknown) => unknown, args: unknown) => callback(args),
  waitForTimeout: async () => {},
} as unknown as Page;

beforeEach(async () => {
  attachments.attach.mockClear();
  dom = new JSDOM(`<body>
    <button id="outside" data-testid="workspace-new-tab-edit-terminal-profiles">Edit profiles</button>
    <div id="ancestor"><div data-testid="command-center-panel">
      <div data-testid="command-center-header"></div>
      <input data-testid="command-center-input">
      <div data-testid="command-center-file-search-status"></div>
      <div data-testid="command-center-results">
        <div data-testid="command-center-files-scope"></div>
        <button data-testid="command-center-file-row-fixture">
          <span data-testid="command-center-file-icon"></span>
          <span id="inside" data-testid="command-center-file-line">fixture</span>
        </button>
      </div>
    </div></div>
  </body>`);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        recordSurfaces = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      constructor(callback: (list: { getEntries(): PerformanceEntry[] }) => void) {
        deliver = (entries) => callback({ getEntries: () => entries });
      }
      observe() {}
    },
  );
  // Exercise the actual self-contained browser callback without a daemon or Metro.
  await startCommandCenterLayoutObservation(page);
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function shift(nodes: Array<Node | undefined>, value = 0.003, hadRecentInput = false): void {
  const rect = { x: 0, y: 0, width: 10, height: 10 } as DOMRectReadOnly;
  deliver([
    {
      name: "",
      entryType: "layout-shift",
      startTime: performance.now(),
      duration: 0,
      value,
      hadRecentInput,
      sources: nodes.map((node) => ({ node, previousRect: rect, currentRect: rect })),
      toJSON: () => ({}),
    } as PerformanceEntry,
  ]);
}

function attachedObservation() {
  return JSON.parse(attachments.attach.mock.calls[0][1].body) as {
    layoutShift: number;
    commandCenterLayoutShift: number;
    layoutShiftEntryCount: number;
    layoutShiftEntries: unknown[];
  };
}

test("positively outside background shifts keep global diagnostics without failing palette stability", async () => {
  shift([document.getElementById("outside")!]);
  await expectStableCommandCenterLayout(page);
  expect(attachedObservation()).toMatchObject({ layoutShift: 0.003, commandCenterLayoutShift: 0 });
});

test.each(["inside", "ancestor"])("counts full shifts on a palette %s", async (id) => {
  shift([document.getElementById(id)!]);
  await expect(expectStableCommandCenterLayout(page)).rejects.toThrow();
  expect(attachedObservation().commandCenterLayoutShift).toBe(0.003);
});

test("mixed background and palette sources count the full entry rather than dividing its score", async () => {
  shift([document.getElementById("outside")!, document.getElementById("inside")!], 0.0015);
  await expect(expectStableCommandCenterLayout(page)).rejects.toThrow();
  expect(attachedObservation().commandCenterLayoutShift).toBe(0.0015);
});

test.each(["missing node", "detached node", "no sources"])(
  "counts unknown attribution: %s",
  async (scenario) => {
    let nodes: Array<Node | undefined> = [];
    if (scenario === "missing node") nodes = [undefined];
    if (scenario === "detached node") nodes = [document.createElement("div")];
    shift(nodes);
    await expect(expectStableCommandCenterLayout(page)).rejects.toThrow();
    expect(attachedObservation().commandCenterLayoutShift).toBe(0.003);
  },
);

test("a missing palette never makes outside attribution authoritative", async () => {
  document.querySelector('[data-testid="command-center-panel"]')!.remove();
  shift([document.getElementById("outside")!]);
  await expect(expectStableCommandCenterLayout(page)).rejects.toThrow();
  expect(attachedObservation().commandCenterLayoutShift).toBe(0.003);
});

test("recent input does not excuse a palette shift", async () => {
  shift([document.getElementById("inside")!], 0.003, true);
  await expect(expectStableCommandCenterLayout(page)).rejects.toThrow();
  expect(attachedObservation().commandCenterLayoutShift).toBe(0.003);
});

test("entry diagnostic cap never stops stability accounting", async () => {
  for (let index = 0; index < 20; index++) shift([document.getElementById("outside")!], 0.0001);
  shift([document.getElementById("inside")!]);
  await expect(expectStableCommandCenterLayout(page)).rejects.toThrow();
  expect(attachedObservation()).toMatchObject({
    commandCenterLayoutShift: 0.003,
    layoutShiftEntryCount: 21,
  });
  expect(attachedObservation().layoutShiftEntries).toHaveLength(20);
});

test("outside attribution does not bypass the existing surface rectangle checks", async () => {
  shift([document.getElementById("outside")!]);
  const panel = document.querySelector('[data-testid="command-center-panel"]')!;
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
    x: 2,
    y: 0,
    width: 0,
    height: 0,
  } as DOMRect);
  recordSurfaces();
  await expect(expectStableCommandCenterLayout(page)).rejects.toThrow(/panel.x/);
});

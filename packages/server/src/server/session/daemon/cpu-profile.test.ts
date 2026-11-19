import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CPU_PROFILE_MAX_DURATION_MS,
  CPU_PROFILE_MAX_FRAMES,
  CPU_PROFILE_SAMPLING_INTERVAL_US,
  CpuProfileError,
  CpuProfiler,
  type CpuProfilerRuntime,
  type InspectorSessionLike,
  type RawCpuProfile,
  createNodeCpuProfilerRuntime,
  sanitizeCpuProfile,
} from "./cpu-profile.js";

const PACKET_ROOT = "/opt/paseo/runtime";

function packetUrl(relative: string): string {
  return `file://${PACKET_ROOT}/${relative}`;
}

function node(
  id: number,
  children: number[],
  callFrame: Partial<RawCpuProfile["nodes"][number]["callFrame"]>,
): RawCpuProfile["nodes"][number] {
  return {
    id,
    children,
    callFrame: {
      functionName: "",
      scriptId: "1",
      url: "",
      lineNumber: 0,
      columnNumber: 0,
      ...callFrame,
    },
  };
}

function rawProfile(nodes: RawCpuProfile["nodes"], samples: number[]): RawCpuProfile {
  return {
    nodes,
    startTime: 1_000,
    endTime: 1_000 + samples.length * 2_000,
    samples,
    timeDeltas: samples.map(() => 2_000),
  };
}

interface FakeSessionLog {
  calls: string[];
  params: Array<{ method: string; params: unknown }>;
}

function fakeRuntime(
  options: {
    profile?: RawCpuProfile;
    failOn?: string;
    inspectorUrl?: string;
    isMainThread?: boolean;
    clock?: () => number;
  } = {},
): { runtime: CpuProfilerRuntime; log: FakeSessionLog; sessionsCreated: () => number } {
  const log: FakeSessionLog = { calls: [], params: [] };
  let created = 0;
  const profile =
    options.profile ??
    rawProfile(
      [
        node(1, [2], { functionName: "(root)", scriptId: "0" }),
        node(2, [], { functionName: "(program)", scriptId: "0" }),
      ],
      [2, 2],
    );
  const runtime: CpuProfilerRuntime = {
    pid: 4242,
    isMainThread: options.isMainThread ?? true,
    inspectorUrl: () => options.inspectorUrl,
    now: options.clock ?? (() => performance.now()),
    createSession(): InspectorSessionLike {
      created += 1;
      return {
        connect: () => {
          log.calls.push("connect");
        },
        disconnect: () => {
          log.calls.push("disconnect");
        },
        post: async (method: string, params?: unknown) => {
          log.calls.push(method);
          log.params.push({ method, params });
          if (options.failOn === method) {
            throw new Error("secret-raw-inspector-value");
          }
          if (method === "Profiler.stop") return { profile };
          return {};
        },
      };
    },
  };
  return { runtime, log, sessionsCreated: () => created };
}

function profilerWith(runtime: CpuProfilerRuntime): CpuProfiler {
  return new CpuProfiler({ packetRoot: PACKET_ROOT, loadRuntime: async () => runtime });
}

async function expectCode(promise: Promise<unknown>, code: CpuProfileError["code"]) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(CpuProfileError);
  expect((error as CpuProfileError).code).toBe(code);
  return error as CpuProfileError;
}

describe("CpuProfiler bounds and ownership", () => {
  test("rejects out-of-range or fractional durations before creating an inspector session", async () => {
    const { runtime, sessionsCreated } = fakeRuntime();
    const profiler = profilerWith(runtime);
    for (const durationMs of [0, -1, 1.5, CPU_PROFILE_MAX_DURATION_MS + 1, Number.NaN]) {
      await expectCode(profiler.capture({ durationMs, owner: {}, scope: {} }), "invalid_duration");
    }
    expect(sessionsCreated()).toBe(0);
  });

  test("captures with a fixed 2000 us interval and closes the session in order", async () => {
    const { runtime, log } = fakeRuntime();
    const profiler = profilerWith(runtime);

    const result = await profiler.capture({ durationMs: 10, owner: {}, scope: {} });

    expect(log.calls).toEqual([
      "connect",
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable",
      "disconnect",
    ]);
    expect(
      log.params.find((entry) => entry.method === "Profiler.setSamplingInterval")?.params,
    ).toEqual({
      interval: CPU_PROFILE_SAMPLING_INTERVAL_US,
    });
    expect(result.samplingIntervalUs).toBe(2000);
    expect(result.requestedDurationMs).toBe(10);
    expect(result.pid).toBe(4242);
    expect(profiler.busy).toBe(false);
  });

  test("rejects a concurrent capture while one is active", async () => {
    const { runtime, sessionsCreated } = fakeRuntime();
    const profiler = profilerWith(runtime);

    const first = profiler.capture({ durationMs: 30, owner: {}, scope: {} });
    await expectCode(profiler.capture({ durationMs: 10, owner: {}, scope: {} }), "busy");
    await first;
    expect(sessionsCreated()).toBe(1);
    expect(profiler.busy).toBe(false);
  });

  test("refuses rather than coexisting with an open inspector listener or off the main thread", async () => {
    const listening = fakeRuntime({ inspectorUrl: "ws://127.0.0.1:9229/abc" });
    await expectCode(
      profilerWith(listening.runtime).capture({ durationMs: 10, owner: {}, scope: {} }),
      "inspector_in_use",
    );
    expect(listening.sessionsCreated()).toBe(0);

    const worker = fakeRuntime({ isMainThread: false });
    await expectCode(
      profilerWith(worker.runtime).capture({ durationMs: 10, owner: {}, scope: {} }),
      "not_main_thread",
    );
    expect(worker.sessionsCreated()).toBe(0);
  });

  test("never stops a profile it did not start, and hides raw inspector errors", async () => {
    const { runtime, log } = fakeRuntime({ failOn: "Profiler.start" });
    const profiler = profilerWith(runtime);

    const error = await expectCode(
      profiler.capture({ durationMs: 10, owner: {}, scope: {} }),
      "profiler_failed",
    );

    expect(log.calls).not.toContain("Profiler.stop");
    expect(log.calls.slice(-2)).toEqual(["Profiler.disable", "disconnect"]);
    expect(error.message).not.toContain("secret-raw-inspector-value");
    expect(profiler.busy).toBe(false);
  });

  test("cancels only the capture owned by the closing physical socket", async () => {
    const { runtime, log } = fakeRuntime();
    const profiler = profilerWith(runtime);
    const socket = {};
    const otherSocket = {};

    const capture = profiler.capture({ durationMs: 2000, owner: socket, scope: {} });
    await waitFor(() => log.calls.includes("Profiler.start"));
    profiler.cancelOwner(otherSocket);
    expect(profiler.busy).toBe(true);
    profiler.cancelOwner(socket);

    await expectCode(capture, "cancelled");
    expect(log.calls.slice(-3)).toEqual(["Profiler.stop", "Profiler.disable", "disconnect"]);
    expect(profiler.busy).toBe(false);
  });

  test("session cleanup and shutdown cancel and release the inspector", async () => {
    for (const cancel of [
      (profiler: CpuProfiler, scope: object) => profiler.cancelScope(scope),
      (profiler: CpuProfiler) => profiler.cancelAll(),
    ]) {
      const { runtime, log } = fakeRuntime();
      const profiler = profilerWith(runtime);
      const scope = {};
      const capture = profiler.capture({ durationMs: 2000, owner: {}, scope });
      await waitFor(() => log.calls.includes("Profiler.start"));
      cancel(profiler, scope);
      await expectCode(capture, "cancelled");
      expect(log.calls.at(-1)).toBe("disconnect");
      expect(profiler.busy).toBe(false);
    }
  });

  test("a cancellation before start still releases the session without stopping", async () => {
    const { runtime, log } = fakeRuntime();
    const profiler = profilerWith(runtime);
    const owner = {};
    const capture = profiler.capture({ durationMs: 2000, owner, scope: {} });
    profiler.cancelOwner(owner);
    await expectCode(capture, "cancelled");
    expect(log.calls).not.toContain("Profiler.stop");
    expect(log.calls.at(-1) === "disconnect" || log.calls.length === 0).toBe(true);
    expect(profiler.busy).toBe(false);
  });

  test("reports the actual monotonic duration and overrun without claiming a hard bound", async () => {
    const ticks = [100, 4_600];
    const { runtime } = fakeRuntime({ clock: () => ticks.shift() ?? 4_600 });
    const profiler = profilerWith(runtime);

    const result = await profiler.capture({ durationMs: 10, owner: {}, scope: {} });

    expect(result.actualDurationMs).toBe(4_500);
    expect(result.overrunMs).toBe(4_490);
    expect(result.overrun).toBe(true);
  });
});

describe("CpuProfiler typed failures", () => {
  const SECRET = "sk-SECRET-token-in-error";

  test("a failed runtime load is a fixed profiler_failed and the next capture retries the load", async () => {
    const { runtime } = fakeRuntime();
    let loads = 0;
    const profiler = new CpuProfiler({
      packetRoot: PACKET_ROOT,
      loadRuntime: async () => {
        loads += 1;
        if (loads === 1) throw new Error(SECRET);
        return runtime;
      },
    });

    const error = await expectCode(
      profiler.capture({ durationMs: 5, owner: {}, scope: {} }),
      "profiler_failed",
    );
    expect(error.message).not.toContain(SECRET);
    expect(profiler.busy).toBe(false);

    await profiler.capture({ durationMs: 5, owner: {}, scope: {} });
    expect(loads).toBe(2);
  });

  test("a throwing inspector connect is a fixed profiler_failed", async () => {
    const { runtime } = fakeRuntime();
    const profiler = profilerWith({
      ...runtime,
      createSession: () => ({
        connect: () => {
          throw new Error(SECRET);
        },
        disconnect: () => {},
        post: async () => ({}),
      }),
    });

    const error = await expectCode(
      profiler.capture({ durationMs: 5, owner: {}, scope: {} }),
      "profiler_failed",
    );
    expect(error.message).not.toContain(SECRET);
    expect(profiler.busy).toBe(false);
  });

  test("a sanitizer throw is a fixed profiler_failed", async () => {
    const poisoned = {
      id: 1,
      children: [],
      get callFrame(): never {
        throw new Error(SECRET);
      },
    } as unknown as RawCpuProfile["nodes"][number];
    const { runtime } = fakeRuntime({ profile: rawProfile([poisoned], [1]) });
    const profiler = profilerWith(runtime);

    const error = await expectCode(
      profiler.capture({ durationMs: 5, owner: {}, scope: {} }),
      "profiler_failed",
    );
    expect(error.message).not.toContain(SECRET);
  });
});

describe("sanitizeCpuProfile", () => {
  const secrets = [
    "sk-SECRET-123",
    "token=abc",
    "id_rsa",
    "evil.example",
    "data:text",
    "prompt text",
    "a b",
    "..%2F",
  ];

  test("emits only packet-relative positions, fixed kinds, counts and time deltas", () => {
    const profile = rawProfile(
      [
        node(1, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11], { functionName: "(root)", scriptId: "0" }),
        node(2, [], {
          functionName: "sk-SECRET-123",
          url: packetUrl("packages/server/dist/server/server/workspace-layout-service.js"),
          lineNumber: 121,
          columnNumber: 14,
        }),
        node(3, [], { functionName: "x", url: "file:///Users/someone/.ssh/id_rsa" }),
        node(4, [], { functionName: "x", url: "https://evil.example/?token=abc" }),
        node(5, [], { functionName: "x", url: "data:text/javascript,prompt text" }),
        node(6, [], { functionName: "x", url: "", scriptId: "77" }),
        node(7, [], { functionName: "(garbage collector)", scriptId: "0" }),
        node(8, [], { functionName: "structuredClone", scriptId: "0" }),
        node(9, [], { functionName: "x", url: packetUrl("packages/a b?token=abc.js") }),
        node(10, [], { functionName: "x", url: packetUrl("../..%2Fid_rsa") }),
        node(11, [], { functionName: "x", url: "node:internal/streams/readable", lineNumber: 4 }),
      ],
      [2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );

    const summary = sanitizeCpuProfile(profile, {
      packetRoot: PACKET_ROOT,
      pid: 1,
      requestedDurationMs: 100,
      actualDurationMs: 100,
    });
    const json = JSON.stringify(summary);

    for (const secret of secrets) expect(json).not.toContain(secret);
    expect(json).not.toContain("functionName");
    expect(json).not.toContain("/Users/");
    expect(json).not.toContain(PACKET_ROOT);

    const packetFrame = summary.frames.find((frame) => frame.kind === "packet");
    expect(packetFrame).toMatchObject({
      file: "packages/server/dist/server/server/workspace-layout-service.js",
      line: 122,
      column: 15,
      selfSamples: 2,
      selfMicros: 4_000,
    });
    expect(summary.frames.filter((frame) => frame.kind === "unknown")).toHaveLength(6);
    expect(summary.frames.every((frame) => frame.kind !== "unknown" || frame.file === null)).toBe(
      true,
    );
    expect(summary.frames.find((frame) => frame.kind === "gc")?.selfSamples).toBe(1);
    expect(summary.frames.find((frame) => frame.kind === "native")?.file).toBeNull();
    expect(summary.frames.find((frame) => frame.kind === "node")?.file).toBe(
      "node:internal/streams/readable",
    );
    expect(summary.sampleCount).toBe(11);
    expect(summary.truncated).toEqual({ frames: false, samples: false, bytes: false });
  });

  test("emits node: frames only for real builtins and bounded internals", () => {
    const urls = [
      "node:fs",
      "node:fs/promises",
      "node:internal/streams/readable",
      "node:sk_secret_token_abc",
      `node:internal/${"a".repeat(200)}`,
      "node:fs?token=abc",
      "node:Internal/Streams",
      "node:internal/../fs",
      "node:",
    ];
    const profile = rawProfile(
      [
        node(
          1,
          urls.map((_, index) => index + 2),
          { functionName: "(root)", scriptId: "0" },
        ),
        ...urls.map((url, index) => node(index + 2, [], { url, lineNumber: index })),
      ],
      urls.map((_, index) => index + 2),
    );
    const summary = sanitizeCpuProfile(profile, {
      packetRoot: PACKET_ROOT,
      pid: 1,
      requestedDurationMs: 10,
      actualDurationMs: 10,
    });

    expect(
      summary.frames.filter((frame) => frame.kind === "node").map((frame) => frame.file),
    ).toEqual(["node:fs", "node:fs/promises", "node:internal/streams/readable"]);
    expect(summary.frames.filter((frame) => frame.kind === "unknown")).toHaveLength(6);
    const json = JSON.stringify(summary);
    for (const leaked of ["sk_secret", "token", "aaaa", "Internal", ".."]) {
      expect(json).not.toContain(leaked);
    }
  });

  test("caps frames to an ancestor-closed subset and marks truncation", () => {
    const count = CPU_PROFILE_MAX_FRAMES * 2;
    const children = Array.from({ length: count }, (_, index) => index + 2);
    const nodes = [
      node(1, children, { functionName: "(root)", scriptId: "0" }),
      ...children.map((id) =>
        node(id, [], { url: packetUrl("packages/server/dist/a.js"), lineNumber: id }),
      ),
    ];
    const summary = sanitizeCpuProfile(rawProfile(nodes, children), {
      packetRoot: PACKET_ROOT,
      pid: 1,
      requestedDurationMs: 100,
      actualDurationMs: 100,
    });

    expect(summary.frames.length).toBeLessThanOrEqual(CPU_PROFILE_MAX_FRAMES);
    expect(summary.truncated.frames).toBe(true);
    const ids = new Set(summary.frames.map((frame) => frame.id));
    expect(summary.frames.every((frame) => frame.parent === null || ids.has(frame.parent))).toBe(
      true,
    );
    expect(summary.totalNodeCount).toBe(count + 1);
  });

  test("caps the serialized response bytes", () => {
    const children = Array.from({ length: 200 }, (_, index) => index + 2);
    const nodes = [
      node(1, children, { functionName: "(root)", scriptId: "0" }),
      ...children.map((id) =>
        node(id, [], { url: packetUrl("packages/server/dist/a.js"), lineNumber: id }),
      ),
    ];
    const summary = sanitizeCpuProfile(rawProfile(nodes, children), {
      packetRoot: PACKET_ROOT,
      pid: 1,
      requestedDurationMs: 100,
      actualDurationMs: 100,
      maxResponseBytes: 4_000,
    });

    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(4_000);
    expect(summary.truncated.bytes).toBe(true);
    expect(summary.frames.length).toBeGreaterThan(0);
  });
});

describe("node:inspector runtime", () => {
  test("takes a real in-process main-thread profile and returns only sanitized frames", async () => {
    const packetRoot = fileURLToPath(new URL("../../../../../..", import.meta.url));
    const profiler = new CpuProfiler({ packetRoot, loadRuntime: createNodeCpuProfilerRuntime });
    const busyUntil = performance.now() + 60;
    const capture = profiler.capture({ durationMs: 40, owner: {}, scope: {} });
    while (performance.now() < busyUntil) Math.sqrt(Math.random());

    const summary = await capture;

    expect(summary.pid).toBe(process.pid);
    expect(summary.frames.some((frame) => frame.kind === "root")).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("functionName");
    expect(JSON.stringify(summary)).not.toContain(packetRoot);
    expect(profiler.busy).toBe(false);
    await profiler.capture({ durationMs: 5, owner: {}, scope: {} });
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

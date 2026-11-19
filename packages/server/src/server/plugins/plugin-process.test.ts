import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginWorker,
  createPluginWorkerFromBundle,
  type PluginWorkerChannel,
} from "./plugin-process.js";
import {
  PluginProcessMessageSchema,
  type PluginProcessMessage,
  type PluginProcessRequest,
} from "./plugin-process-protocol.js";

it("keeps React out of the plugin host's runtime dependency graph", async () => {
  await expect(
    build({
      entryPoints: [
        fileURLToPath(new URL("./plugin-process.ts", import.meta.url)),
        "@getpaseo/plugin",
        "@getpaseo/plugin/server",
        "@getpaseo/plugin/server/provider",
        "@getpaseo/plugin/server/acp",
      ],
      outdir: "unused",
      conditions: ["source"],
      bundle: true,
      platform: "node",
      format: "esm",
      // Node evaluates re-exports even when the host only imports one helper.
      treeShaking: false,
      write: false,
      logLevel: "silent",
      plugins: [
        {
          name: "no-react",
          setup(context) {
            context.onResolve(
              { filter: /^(react|react-dom|react-native|use-sync-external-store)(\/|$)/ },
              ({ path, importer }) => ({
                errors: [{ text: `React dependency ${path} imported by ${importer}` }],
              }),
            );
          },
        },
      ],
    }),
  ).resolves.toMatchObject({ errors: [] });
});

it("exposes CLI probes through the plugin host's server SDK", async () => {
  const { evaluateBundle } = await import("./bundle-evaluator.js");
  const setup = evaluateBundle(`(require) => ({ default: async () => {
    const { execCommand } = require("@getpaseo/plugin/server");
    const { stdout } = await execCommand(${JSON.stringify(process.execPath)}, ["-e", "process.stdout.write('plugin CLI ready')"]);
    if (stdout !== "plugin CLI ready") throw new Error("CLI output was lost");
  } })`);
  // This contribution uses no server context APIs; it exercises the host's real SDK binding.
  await expect(setup(undefined as never)).resolves.toBeUndefined();
});

describe("plugin initialization diagnostics", () => {
  function fixture(
    contribute: Parameters<typeof createPluginWorker>[0]["contribute"],
    bundle?: string,
    dropDiagnostics = false,
  ) {
    const handlers = new Set<(message: PluginProcessRequest) => void>();
    const messages: PluginProcessMessage[] = [];
    let sawHello!: () => void;
    const hello = new Promise<void>((resolve) => {
      sawHello = resolve;
    });
    const channel: PluginWorkerChannel = {
      send(message, callback) {
        if (dropDiagnostics && message.type === "initialization.phase")
          throw new Error("synthetic diagnostic sink unavailable");
        messages.push(message);
        if (
          message.type === "paseo_frame" &&
          typeof message.data === "string" &&
          JSON.parse(message.data).type === "hello"
        )
          sawHello();
        callback?.();
      },
      onMessage(handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
      disconnect() {},
    };
    const deliver = (message: PluginProcessRequest) => {
      for (const handler of handlers) handler(message);
    };
    const initializeMessage: Extract<PluginProcessRequest, { type: "initialize" }> = {
      type: "initialize",
      pluginId: "diagnostic-fixture",
      appVersion: "0.14.0",
      pluginDirectory: "/private/synthetic-path-not-logged",
      bundle: bundle ?? "",
    };
    const worker =
      bundle === undefined
        ? createPluginWorker({ channel, contribute })
        : createPluginWorkerFromBundle({ channel, message: initializeMessage });
    deliver(initializeMessage);
    return {
      worker,
      messages,
      hello,
      messageTypes: () => messages.map((message) => message.type),
      phases: () => messages.filter((message) => message.type === "initialization.phase"),
      answerHello: () =>
        deliver({
          type: "paseo_frame",
          isBinary: false,
          data: JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "synthetic-server",
                hostname: "synthetic-host",
                version: "0.14.0",
                features: {},
              },
            },
          }),
        }),
    };
  }

  it("distinguishes a held hello from contribution without emitting ready", async () => {
    const contribute = vi.fn(() => () => undefined);
    const f = fixture(contribute);
    try {
      await vi.waitFor(() => expect(f.messageTypes()).toContain("paseo_frame"));
      await f.hello;
      expect(f.phases().map((message) => message.phase)).toEqual([
        "initialize-received",
        "hello-sent",
      ]);
      expect(contribute).not.toHaveBeenCalled();
      expect(f.messages.some((message) => message.type === "ready")).toBe(false);
    } finally {
      await f.worker.shutdown();
    }
  });

  it("reports successful IPC and contribution phases with no payloads or private paths", async () => {
    const f = fixture(() => () => undefined);
    try {
      await f.hello;
      f.answerHello();
      await vi.waitFor(() => expect(f.messageTypes()).toContain("ready"));
      expect(f.phases().map((message) => message.phase)).toEqual([
        "initialize-received",
        "hello-sent",
        "server-info-received",
        "contribute-started",
        "contribute-returned",
        "ready-sent",
      ]);
      for (const message of f.phases()) {
        expect(Object.keys(message).sort()).toEqual(["elapsedMs", "phase", "type"]);
        expect(message.elapsedMs).toBeGreaterThanOrEqual(0);
      }
      expect(JSON.stringify(f.phases())).not.toContain("synthetic-path-not-logged");
      expect(JSON.stringify(f.phases())).not.toContain("synthetic-server");
    } finally {
      await f.worker.shutdown();
    }
  });

  it("distinguishes a throwing contribution from handshake failure and never emits ready", async () => {
    const f = fixture(() => {
      throw new Error("synthetic contribution failure");
    });
    try {
      await f.hello;
      f.answerHello();
      await vi.waitFor(() => expect(f.messageTypes()).toContain("fatal"));
      expect(f.phases().map((message) => message.phase)).toEqual([
        "initialize-received",
        "hello-sent",
        "server-info-received",
        "contribute-started",
      ]);
      expect(f.messages.some((message) => message.type === "ready")).toBe(false);
    } finally {
      await f.worker.shutdown();
    }
  });

  it("marks actual bundle evaluation before synthetic IPC initialization", async () => {
    const f = fixture(() => () => undefined, `(require) => ({ default: () => () => undefined })`);
    try {
      await f.hello;
      f.answerHello();
      await vi.waitFor(() => expect(f.messageTypes()).toContain("ready"));
      expect(f.phases().map((message) => message.phase)).toEqual([
        "initialize-received",
        "evaluation-started",
        "evaluation-completed",
        "hello-sent",
        "server-info-received",
        "contribute-started",
        "contribute-returned",
        "ready-sent",
      ]);
    } finally {
      await f.worker.shutdown();
    }
  });

  it("distinguishes evaluation failure before any hello or ready", () => {
    const messages: PluginProcessMessage[] = [];
    const channel: PluginWorkerChannel = {
      send: (message) => {
        messages.push(message);
      },
      onMessage: () => () => {},
      disconnect() {},
    };
    expect(() =>
      createPluginWorkerFromBundle({
        channel,
        message: {
          type: "initialize",
          pluginId: "synthetic-eval",
          bundle: `(require) => { throw new Error("synthetic evaluation failure"); }`,
          appVersion: "0.14.0",
          pluginDirectory: "/private/not-read",
        },
      }),
    ).toThrow("synthetic evaluation failure");
    expect(
      messages
        .filter((message) => message.type === "initialization.phase")
        .map((message) => message.phase),
    ).toEqual(["initialize-received", "evaluation-started"]);
    expect(
      messages.some((message) => message.type === "paseo_frame" || message.type === "ready"),
    ).toBe(false);
  });

  it("keeps diagnostic delivery failure out of startup decisions", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture(() => () => undefined, undefined, true);
    try {
      await f.hello;
      f.answerHello();
      await vi.waitFor(() => expect(f.messageTypes()).toContain("ready"));
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "Plugin initialization diagnostics unavailable",
      );
    } finally {
      await f.worker.shutdown();
      warning.mockRestore();
    }
  });

  it("accepts only finite, bounded-shape phase metadata", () => {
    const message = { type: "initialization.phase", phase: "hello-sent", elapsedMs: 1 };
    expect(PluginProcessMessageSchema.safeParse(message).success).toBe(true);
    for (const invalid of [
      { ...message, elapsedMs: -1 },
      { ...message, elapsedMs: Infinity },
      { ...message, phase: "arbitrary-payload" },
      { ...message, privatePath: "/private/not-logged" },
    ]) {
      expect(PluginProcessMessageSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

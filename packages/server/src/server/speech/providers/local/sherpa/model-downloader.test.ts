import { afterEach, describe, expect, test, vi } from "vitest";
import { channel } from "node:diagnostics_channel";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { gzipSync } from "node:zlib";
import * as modelCatalog from "./model-catalog.js";

const downloadDirectoryGate = vi.hoisted(() => ({
  directory: "",
  wait: undefined as Promise<void> | undefined,
  error: undefined as Error | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (args[0] === downloadDirectoryGate.directory) {
        if (downloadDirectoryGate.error) throw downloadDirectoryGate.error;
        await downloadDirectoryGate.wait;
      }
      return actual.mkdir(...args);
    },
  };
});
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  truncateSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { ensureSherpaOnnxModel, getSherpaOnnxModelDir } from "./model-downloader.js";
import { getSherpaOnnxModelSpec } from "./model-catalog.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-speech-models-"));
}

type Framing = "length" | "eof" | "truncated-length" | "truncated-chunked";

function trackSocket(sockets: Set<Socket>, errors: Error[], socket: Socket): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", (error) => errors.push(error));
}

function createFinServer(
  body: Buffer,
  framing: Framing,
  sockets: Set<Socket>,
  errors: Error[],
): Server {
  let headers = "";
  if (framing === "truncated-chunked") headers = "Transfer-Encoding: chunked\r\n";
  else if (framing !== "eof")
    headers = `Content-Length: ${body.length * (framing === "truncated-length" ? 2 : 1)}\r\n`;
  const response = Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\n${headers}Connection: close\r\n\r\n`),
    ...(framing === "truncated-chunked" ? [Buffer.from(`${body.length.toString(16)}\r\n`)] : []),
    body,
  ]);
  return createServer((socket) => {
    trackSocket(sockets, errors, socket);
    socket.once("data", () => socket.end(response));
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.closed) return;
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

const logger = pino({ level: "silent" });

describe("sherpa model downloader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    downloadDirectoryGate.directory = "";
    downloadDirectoryGate.wait = undefined;
    downloadDirectoryGate.error = undefined;
  });

  test("keeps built-in streamed fetch compatible with the fixed shared transport", async () => {
    const body = Buffer.alloc(64 * 1024, 0x61);
    const sockets = new Set<Socket>();
    const errors: Error[] = [];
    const server = createFinServer(body, "length", sockets, errors);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const connected = channel("undici:client:connected");
    const onConnected = (message: unknown) => {
      const { socket } = message as { socket: Socket };
      if (socket.remotePort === address.port) socket.once("end", resolveEnd);
    };
    connected.subscribe(onConnected);
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${address.port}/`);
      await ended;
      expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
      expect(errors).toEqual([]);
    } finally {
      connected.unsubscribe(onConnected);
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });

  test.each(["length", "eof", "truncated-length", "truncated-chunked"] as const)(
    "handles a %s response ending while the download consumer is paused",
    async (framing) => {
      const root = makeTmpDir();
      const modelsDir = path.join(root, "models");
      const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
      const sourceDir = path.join(root, "source", spec.extractedDir);
      mkdirSync(path.join(sourceDir, "espeak-ng-data"), { recursive: true });
      for (const file of ["model.onnx", "voices.bin", "tokens.txt"]) {
        writeFileSync(path.join(sourceDir, file), "complete model data");
      }
      const archive = path.join(root, "fixture.tar");
      execFileSync("tar", ["cf", archive, "-C", path.dirname(sourceDir), spec.extractedDir]);
      const body = Buffer.alloc(64 * 1024);
      readFileSync(archive).copy(body);
      let socketEnded = false;
      let resolveEnd!: () => void;
      const ended = new Promise<void>((resolve) => {
        resolveEnd = resolve;
      });
      const sockets = new Set<Socket>();
      const socketErrors: Error[] = [];
      const server = createFinServer(body, framing, sockets, socketErrors);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const url = `http://127.0.0.1:${address.port}/model.tar`;
      const connected = channel("undici:client:connected");
      const onConnected = (message: unknown) => {
        const { socket } = message as { socket: Socket };
        if (socket.remotePort === address.port) {
          socket.once("end", () => {
            socketEnded = true;
            resolveEnd();
          });
        }
      };
      connected.subscribe(onConnected);
      vi.spyOn(modelCatalog, "getSherpaOnnxModelSpec").mockReturnValue({
        ...spec,
        archiveUrl: url,
      });
      downloadDirectoryGate.directory = path.join(modelsDir, ".downloads");
      // Release the consumer only after the client observes FIN. A flowing body
      // would miss the paused-parser regression in undici#5474.
      downloadDirectoryGate.wait = ended;
      const progress: number[] = [];
      try {
        const install = ensureSherpaOnnxModel({
          modelsDir,
          modelId: spec.id,
          logger,
          onProgress: (value) => {
            if (value.phase === "downloading") progress.push(value.receivedBytes);
          },
        });
        if (framing.startsWith("truncated")) {
          await expect(install).rejects.toThrow();
          expect(existsSync(getSherpaOnnxModelDir(modelsDir, spec.id))).toBe(false);
        } else {
          const modelDir = await install;
          expect(readFileSync(path.join(modelDir, "model.onnx"), "utf8")).toBe(
            "complete model data",
          );
          expect(progress.at(-1)).toBe(body.length);
          expect(
            progress.every((value, index) => index === 0 || value > progress[index - 1]!),
          ).toBe(true);
        }
        expect(socketEnded).toBe(true);
        expect(readdirSync(path.join(modelsDir, ".downloads"))).toEqual([]);
      } finally {
        resolveEnd();
        connected.unsubscribe(onConnected);
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["redirect-gzip", "http-error", "abort", "mkdir-error", "ambient-dispatcher"] as const)(
    "preserves download lifecycle for %s",
    async (mode) => {
      const root = makeTmpDir();
      const modelsDir = path.join(root, "models");
      const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
      const sourceDir = path.join(root, "source", spec.extractedDir);
      mkdirSync(path.join(sourceDir, "espeak-ng-data"), { recursive: true });
      for (const file of ["model.onnx", "voices.bin", "tokens.txt"]) {
        writeFileSync(path.join(sourceDir, file), "complete model data");
      }
      const archive = path.join(root, "fixture.tar");
      execFileSync("tar", ["cf", archive, "-C", path.dirname(sourceDir), spec.extractedDir]);
      const body = Buffer.alloc(64 * 1024);
      readFileSync(archive).copy(body);
      const sockets = new Set<Socket>();
      const requests: string[] = [];
      const socketErrors: Error[] = [];
      const server = createHttpServer((request, response) => {
        requests.push(request.url ?? "");
        if (mode === "redirect-gzip" && request.url === "/model") {
          response.writeHead(302, { location: "/archive" }).end();
          return;
        }
        const bytes = mode === "redirect-gzip" ? gzipSync(body) : body;
        response.writeHead(mode === "http-error" ? 404 : 200, {
          "content-length": bytes.length,
          ...(mode === "redirect-gzip" ? { "content-encoding": "gzip" } : {}),
        });
        response.end(bytes);
      });
      server.on("connection", (socket) => {
        trackSocket(sockets, socketErrors, socket);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      vi.spyOn(modelCatalog, "getSherpaOnnxModelSpec").mockReturnValue({
        ...spec,
        archiveUrl: `http://127.0.0.1:${address.port}/model`,
      });
      const controller = new AbortController();
      if (mode === "mkdir-error") {
        downloadDirectoryGate.directory = path.join(modelsDir, ".downloads");
        downloadDirectoryGate.error = new Error("fixture mkdir failure");
      }
      const { getGlobalDispatcher, MockAgent, setGlobalDispatcher } = await import("undici");
      const originalDispatcher = getGlobalDispatcher();
      const ambient = new MockAgent();
      ambient.disableNetConnect();
      if (mode === "ambient-dispatcher") setGlobalDispatcher(ambient);
      try {
        const install = ensureSherpaOnnxModel({
          modelsDir,
          modelId: spec.id,
          logger,
          signal: controller.signal,
          onProgress: (progress) => {
            if (mode === "abort" && progress.phase === "downloading") controller.abort();
          },
        });
        if (mode === "http-error" || mode === "abort" || mode === "mkdir-error") {
          let expected: string | RegExp = /abort/i;
          if (mode === "http-error") expected = "404";
          if (mode === "mkdir-error") expected = "fixture mkdir failure";
          await expect(install).rejects.toThrow(expected);
          expect(existsSync(getSherpaOnnxModelDir(modelsDir, spec.id))).toBe(false);
        } else {
          const modelDir = await install;
          expect(readFileSync(path.join(modelDir, "model.onnx"), "utf8")).toBe(
            "complete model data",
          );
          expect(readdirSync(path.join(modelsDir, ".downloads"))).toEqual([]);
        }
        if (mode === "abort") expect(readdirSync(path.join(modelsDir, ".downloads"))).toEqual([]);
        expect(requests).toEqual(mode === "redirect-gzip" ? ["/model", "/archive"] : ["/model"]);
        // The owned dispatcher closes unread error bodies without fixture teardown.
        await Promise.all([...sockets].map(waitForSocketClose));
        expect(sockets.size).toBe(0);
        expect(socketErrors.every((error) => "code" in error && error.code === "ECONNRESET")).toBe(
          true,
        );
      } finally {
        setGlobalDispatcher(originalDispatcher);
        await ambient.close();
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("does not expose a partial model when tar extraction fails", async () => {
    const root = makeTmpDir();
    const modelsDir = path.join(root, "models");
    const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
    const sourceDir = path.join(root, "source", spec.extractedDir);
    const archive = path.join(
      modelsDir,
      ".downloads",
      path.basename(new URL(spec.archiveUrl).pathname),
    );
    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(path.dirname(archive), { recursive: true });
      writeFileSync(path.join(sourceDir, "model.onnx"), Buffer.alloc(32_768, 1));
      execFileSync("tar", [
        "cf",
        archive,
        "-C",
        path.dirname(sourceDir),
        `${spec.extractedDir}/model.onnx`,
      ]);
      truncateSync(archive, 1_024);
      await expect(ensureSherpaOnnxModel({ modelsDir, modelId: spec.id, logger })).rejects.toThrow(
        "tar exited",
      );
      expect(existsSync(getSherpaOnnxModelDir(modelsDir, spec.id))).toBe(false);
      expect(existsSync(archive)).toBe(true);
      expect(readdirSync(modelsDir)).toEqual([".downloads"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs a partial legacy extraction when its cached archive remains", async () => {
    const root = makeTmpDir();
    const modelsDir = path.join(root, "models");
    const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
    const sourceDir = path.join(root, "source", spec.extractedDir);
    const modelDir = getSherpaOnnxModelDir(modelsDir, spec.id);
    const archive = path.join(
      modelsDir,
      ".downloads",
      path.basename(new URL(spec.archiveUrl).pathname),
    );
    try {
      for (const dir of [sourceDir, modelDir]) {
        mkdirSync(path.join(dir, "espeak-ng-data"), { recursive: true });
        for (const filename of ["model.onnx", "voices.bin", "tokens.txt"]) {
          writeFileSync(path.join(dir, filename), "complete model data");
        }
      }
      mkdirSync(path.dirname(archive), { recursive: true });
      execFileSync("tar", ["cf", archive, "-C", path.dirname(sourceDir), spec.extractedDir]);
      writeFileSync(path.join(modelDir, "model.onnx"), "truncated");
      await ensureSherpaOnnxModel({ modelsDir, modelId: spec.id, logger });
      expect(readFileSync(path.join(modelDir, "model.onnx"), "utf8")).toBe("complete model data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("getSherpaOnnxModelDir maps modelId to extractedDir", () => {
    const modelsDir = "/tmp/models";
    expect(getSherpaOnnxModelDir(modelsDir, "parakeet-tdt-0.6b-v2-int8")).toContain(
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    );
    expect(getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19")).toContain("kokoro-en-v0_19");
  });

  test("ensureSherpaOnnxModel succeeds without downloading when files exist", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19");

    mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
    writeFileSync(path.join(modelDir, "model.onnx"), "x");
    writeFileSync(path.join(modelDir, "voices.bin"), "x");
    writeFileSync(path.join(modelDir, "tokens.txt"), "x");

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "kokoro-en-v0_19",
      logger,
    });

    expect(out).toBe(modelDir);
  });
});

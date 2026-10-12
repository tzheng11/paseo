import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { InMemoryAgentTimelineStore } from "../src/server/agent/agent-timeline-store.js";
import { DiskAgentTimelineStore } from "../src/server/agent/disk-agent-timeline-store.js";

const backend = process.argv[2];
if (backend !== "memory" && backend !== "disk")
  throw new Error("Usage: measure-timeline-memory.ts memory|disk [rows] [payloadBytes]");
const count = Number(process.argv[3] ?? 50_000);
const payloadBytes = Number(process.argv[4] ?? 8192);
if (
  !Number.isSafeInteger(count) ||
  count < 1 ||
  !Number.isSafeInteger(payloadBytes) ||
  payloadBytes < 1
)
  throw new Error("rows and payloadBytes must be positive integers");
if (!global.gc) throw new Error("Run with node --expose-gc --import tsx");
const directory = mkdtempSync(path.join(tmpdir(), "paseo-timeline-bench-"));
const store =
  backend === "disk" ? new DiskAgentTimelineStore({ directory }) : new InMemoryAgentTimelineStore();
try {
  const agents = Array.from({ length: 50 }, (_, index) => `agent-${index}`);
  for (const agent of agents) store.initialize(agent);
  global.gc();
  const baseline = process.memoryUsage();
  const started = performance.now();
  for (let agentIndex = 0; agentIndex < agents.length; agentIndex++) {
    const agentCount =
      Math.floor(count / agents.length) + (agentIndex < count % agents.length ? 1 : 0);
    for (let offset = 0; offset < agentCount; offset += 64) {
      const batch = Array.from({ length: Math.min(64, agentCount - offset) }, () => ({
        item: {
          type: "user_message" as const,
          text: randomBytes(Math.ceil(payloadBytes / 2))
            .toString("hex")
            .slice(0, payloadBytes),
        },
      }));
      store.appendBatch(agents[agentIndex], batch);
    }
  }
  const appendMs = performance.now() - started;
  global.gc();
  const retained = process.memoryUsage();
  const readStarted = performance.now();
  let returned = 0;
  for (const agent of agents) returned += store.fetch(agent, { limit: 20 }).rows.length;
  const fetchMs = performance.now() - readStarted;
  process.stdout.write(
    JSON.stringify(
      {
        backend,
        count,
        payloadBytes,
        agents: agents.length,
        appendMs,
        fetchMs,
        returned,
        retainedHeapMiB: (retained.heapUsed - baseline.heapUsed) / 1024 ** 2,
        retainedRssMiB: (retained.rss - baseline.rss) / 1024 ** 2,
        cachedMiB: store instanceof DiskAgentTimelineStore ? store.cachedBytes / 1024 ** 2 : null,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  if (store instanceof DiskAgentTimelineStore) store.close();
  rmSync(directory, { recursive: true, force: true });
}

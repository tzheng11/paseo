# Ad-hoc daemon testing

Spin up an isolated in-process daemon test harness without touching the main daemon on port 6767.

This is for test code only. Executable daemon processes must start through
`scripts/supervisor-entrypoint.ts` or `dist/scripts/supervisor-entrypoint.js`;
do not use `createPaseoDaemon` as a product launch path.

## Quick start

```typescript
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { createPaseoDaemon } from "./bootstrap.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const logger = pino({ level: "warn" });
const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-test-"));
const paseoHome = path.join(paseoHomeRoot, ".paseo");
await mkdir(paseoHome, { recursive: true });
const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));

const daemon = await createPaseoDaemon(
  {
    listen: "127.0.0.1:0", // OS picks a free port
    paseoHome,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: false,
    staticDir,
    mcpDebug: false,
    agentClients: {},
    agentStoragePath: path.join(paseoHome, "agents"),
    relayEnabled: false,
    relayEndpoint: "relay.paseo.sh:443",
    appBaseUrl: "https://app.paseo.sh",
    // Add custom config here, e.g.:
    // providerOverrides: { ... },
  },
  logger,
);

await daemon.start();
const target = daemon.getListenTarget();
const port = target!.type === "tcp" ? target!.port : null;

const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  appVersion: "0.1.70", // see gotcha #1
});
await client.connect();
await client.fetchAgents({ subscribe: {} });

// ... do your testing ...

await client.close();
await daemon.stop();
await rm(paseoHomeRoot, { recursive: true, force: true });
await rm(staticDir, { recursive: true, force: true });
```

Run with:

```bash
npx tsx packages/server/src/server/your-script.ts
```

## Using the test helper

For simpler cases, `createTestPaseoDaemon` + `DaemonClient` handles temp dirs and port selection:

```typescript
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const daemon = await createTestPaseoDaemon();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.1.70",
});
await client.connect();
await client.fetchAgents({ subscribe: {} });

// ... test ...

await client.close();
await daemon.close(); // stops daemon + cleans up temp dirs
```

The test helper does **not** expose `providerOverrides`. In test harnesses, use `createPaseoDaemon` directly when you need it (see quick start above).

## macOS Git and watcher load

Use `packages/server/scripts/measure-workspace-watch-load.ts` for the isolated real Git/FSEvents replay. It creates its own repositories and daemon home, uses an ephemeral loopback port, and bounds its child with an external watchdog. Run it through the host's heavy-job admission wrapper. Never point its entry overrides at a serving runtime.

The default topology is 85 repositories with 160 packages each. Repeat with `PASEO_WATCH_LOAD_FD_LIMIT=256` and `1024`. Native setup uses the Git service's observation admission bound; starting 85 inventories together exercises a different load. Set `PASEO_WATCH_LOAD_NEXT_ROOT` to an installed Next app's node_modules. The real build starts only after every workspace's tracked edit reaches the daemon. Its child has a separate 4,096 descriptor limit so a build-process EMFILE does not masquerade as a watcher result.

The all-polling phase deliberately rejects watcher admission with EMFILE and holds polling refresh dependencies pending. Other checkout operations remain real Git. It measures an uncached demand snapshot while the fault is present, releases the hold, then requires native recovery and an edit callback from every workspace. This reproduces starvation tolerance at known boundaries; it does not identify why a production dependency stopped settling. The separate fresh-daemon phase measures actual checkout_status protocol reads during cold refresh.

For a focused failure comparison, set `PASEO_WATCH_LOAD_POLLING_ONLY=1`. `PASEO_WATCH_LOAD_GIT_SERVICE_ENTRY` can select a preserved compiled service; `PASEO_WATCH_LOAD_EXPECT_STARVATION=1` records the old failure rather than calling it a candidate pass. Use independent validation copies with workspace links bound to their own packages. Preserve failed attempts and admission diagnostics.

Full tracked-edit coverage and actual cold reads below ten seconds are functional requirements. Responsiveness acceptance needs paired complete windows under the same load: compare distinct stalls over ten seconds, count per hour, maximum and histogram p99 at the same resolution. Short successful runs do not establish that comparison.

## Common client methods

```typescript
// Provider discovery
const snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
const models = await client.listProviderModels("claude");
const modes = await client.listProviderModes("claude");

// Agent lifecycle
const agent = await client.createAgent({ provider: "claude", cwd: "/tmp" });
await client.sendMessage(agent.id, "Hello");
const updated = await client.waitForAgentUpsert(agent.id, (s) => s.status === "idle");
```

## Gotchas

### 1. appVersion gates provider visibility

The daemon hides non-legacy providers (anything other than claude, codex, opencode) from clients that don't send an `appVersion >= 0.1.45`. The `DaemonClient` sends no version by default, so custom providers like ACP-based ones will be invisible in snapshot responses.

Always pass `appVersion`:

```typescript
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  appVersion: "0.1.70",
});
```

### 2. Provider snapshots are async

After the daemon starts, providers are probed in the background. The first `getProvidersSnapshot()` call will likely return `status: "loading"` for most providers. Poll until the provider you care about is no longer loading:

```typescript
let snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
for (let i = 0; i < 20; i++) {
  const entry = snapshot.entries.find((e) => e.provider === "gemini");
  if (entry && entry.status !== "loading") break;
  await new Promise((r) => setTimeout(r, 2_000));
  snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
}
```

### 3. fetchAgents is required before most operations

Call `client.fetchAgents()` after connecting. The daemon session expects this handshake before it processes other requests — without it, messages like `get_providers_snapshot_request` will silently hang.

### 4. listen: "127.0.0.1:0" for port allocation

Always use port `0` so the OS picks a free port. Never hardcode a port — it will collide with the main daemon or other test runs.

### 5. Script must live inside packages/server

The test utilities use relative imports through the TypeScript project. Place your script somewhere under `packages/server/src/` and import from there. Scripts outside the repo will fail with module resolution errors.

### 6. Cleanup on failure

Wrap your test logic in try/finally to ensure the daemon stops and temp dirs are cleaned up, even if an assertion fails:

```typescript
try {
  // ... test logic ...
} finally {
  await client.close();
  await daemon.stop().catch(() => undefined);
  await rm(paseoHomeRoot, { recursive: true, force: true });
}
```

### 7. ACP providers spawn real processes

When testing ACP providers (e.g., Gemini with `extends: "acp"`), the daemon will spawn real processes to probe for models and modes. The binary must be installed and on PATH. Probing can take 5-15 seconds depending on the provider.

import path from "node:path";
import { homedir } from "node:os";
import type { StoredAgentRecord } from "./agent-storage.js";
import { claudeTranscriptPath } from "./providers/claude/project-dir.js";

/** Pure filesystem history lookup: never instantiate a provider or start a catalog/session. */
export async function persistedHistoryPaths(
  records: readonly StoredAgentRecord[],
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const paths = new Set<string>();
  const homeDir = options.homeDir ?? homedir();
  for (const record of records) {
    const add = (value: unknown) => {
      if (typeof value !== "string" || !value.length) return;
      if (path.isAbsolute(value)) paths.add(path.resolve(value));
      else if (value.startsWith("~/")) {
        paths.add(path.join(homeDir, value.slice(2)));
        paths.add(path.resolve(record.cwd, value));
      } else throw new Error("reclaim_history_inventory_unverified");
    };
    const handle = record.persistence?.nativeHandle;
    if (
      typeof handle === "string" &&
      (path.isAbsolute(handle) ||
        (["pi", "omp"].includes(record.provider) && /[\\/]|\.jsonl$/.test(handle)))
    )
      add(handle);
    const visit = (value: unknown, depth = 0): void => {
      if (!value || typeof value !== "object") return;
      if (depth > 20) throw new Error("reclaim_history_inventory_unverified");
      for (const [key, field] of Object.entries(value)) {
        if (
          /^(path|(history|transcript|session|rollout)(Path|File|FilePath|Dir|Directory|Root))$/i.test(
            key.replace(/[_-]/g, ""),
          )
        )
          add(field);
        if (field && typeof field === "object") visit(field, depth + 1);
      }
    };
    visit(record.persistence?.metadata);
    if (handle && typeof handle === "object") visit(handle);
    visit(record.config?.providerOptions);
    await addProviderHistoryPaths({
      record,
      homeDir,
      env: { ...(options.env ?? process.env), ...record.launchEnv },
      add,
    });
  }
  return [...paths].sort();
}

async function addProviderHistoryPaths({
  record,
  homeDir,
  env,
  add,
}: {
  record: StoredAgentRecord;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  add: (value: unknown) => void;
}): Promise<void> {
  for (const key of [
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
    "CLAUDE_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "OMP_CONFIG_DIR",
    "OMP_SESSION_DIR",
  ])
    add(env[key]);
  if (record.provider === "claude") {
    const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, ".claude");
    add(configDir);
    add(path.join(configDir, "projects"));
    const sessionId = record.persistence?.sessionId;
    if (sessionId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
        throw new Error("reclaim_history_inventory_unverified");
      const transcript = await claudeTranscriptPath({ cwd: record.cwd, sessionId, configDir });
      add(transcript);
      add(path.join(path.dirname(transcript), path.basename(transcript, ".jsonl"), "subagents"));
    }
  }
  if (record.provider === "codex") {
    const codexHome = env.CODEX_HOME ?? path.join(homeDir, ".codex");
    const sqliteHome = env.CODEX_SQLITE_HOME ?? codexHome;
    add(codexHome);
    add(sqliteHome);
    add(path.join(sqliteHome, "thread_history_1.sqlite"));
    add(path.join(codexHome, "sessions"));
    add(path.join(codexHome, "archived_sessions"));
  }
  if (record.provider === "pi") add(path.join(homeDir, ".pi", "agent", "sessions"));
  if (record.provider === "omp") add(path.join(homeDir, ".omp", "agent", "sessions"));
}

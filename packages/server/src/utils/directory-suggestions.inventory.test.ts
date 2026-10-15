import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const runInventory = vi.hoisted(() => vi.fn());
vi.mock("./run-git-command.js", () => ({
  runGitCommand: runInventory,
  createRunGitCommand: () => runInventory,
}));
import { searchDirectoryEntries } from "./directory-suggestions.js";

afterEach(() => {
  vi.useRealTimers();
  runInventory.mockReset();
});

test("workspace suggestions share an inventory throughout a long queue wait and cache from completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-suggestions-inventory-"));
  await mkdir(path.join(root, "src"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  let release!: (value: { stdout: string }) => void;
  runInventory.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  runInventory.mockResolvedValue({ stdout: "" });
  const search = () =>
    searchDirectoryEntries({ root, query: "src", pathFormat: "relative", respectGitIgnore: true });
  try {
    const first = search();
    await vi.waitFor(() => expect(runInventory).toHaveBeenCalledTimes(1));
    vi.setSystemTime(20_000);
    const second = search();
    expect(runInventory).toHaveBeenCalledTimes(1);
    release({ stdout: "" });
    await expect(first).resolves.toContainEqual({ path: "src", kind: "directory" });
    await expect(second).resolves.toContainEqual({ path: "src", kind: "directory" });
    await search();
    expect(runInventory).toHaveBeenCalledTimes(1);
    vi.setSystemTime(28_001);
    await search();
    expect(runInventory).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

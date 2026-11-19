import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runArchiveCommandWithDeps } from "./archive.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

function createFakeDaemonClient(
  overrides: Partial<
    Pick<DaemonClient, "getPaseoWorktreeList" | "archivePaseoWorktree" | "close">
  > = {},
): DaemonClient {
  return {
    getPaseoWorktreeList: async () => ({
      worktrees: [],
      error: null,
      requestId: "req-list",
    }),
    archivePaseoWorktree: async () => ({
      success: true,
      removedAgents: [],
      error: null,
      requestId: "req-archive",
    }),
    close: async () => {},
    ...overrides,
  } as unknown as DaemonClient;
}

// NOTE: This file tests CLI routing/resolution only. The actual directory-removal
// outcome is covered by composition: workspace-archive-service.test.ts and
// worktree-session.test.ts prove real filesystem removal end-to-end.

describe("runArchiveCommand", () => {
  it("sends scope worktree when archiving by worktree path", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature";
    const archiveCalls: Array<{
      input: Parameters<DaemonClient["archivePaseoWorktree"]>[0];
    }> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push({ input });
        return {
          success: true,
          removedAgents: ["agent-1"],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    const result = await runArchiveCommandWithDeps(
      "feature",
      { daemonTarget },
      {
        connectToDaemon: async (options) => {
          expect(options.target).toEqual(daemonTarget);
          return fakeClient;
        },
      },
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input.scope).toBe("worktree");
    expect(archiveCalls[0]?.input.worktreePath).toBe(worktreePath);
    expect(result).toEqual({
      type: "single",
      data: {
        name: "feature",
        status: "archived",
        removedAgents: ["agent-1"],
      },
      schema: expect.any(Object),
    });
  });

  it("archives by matching branch name when no directory name matches", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature-branch";
    const archiveCalls: Array<{
      input: Parameters<DaemonClient["archivePaseoWorktree"]>[0];
    }> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature-x",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push({ input });
        return {
          success: true,
          removedAgents: [],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    await runArchiveCommandWithDeps(
      "feature-x",
      { daemonTarget },
      {
        connectToDaemon: async (options) => {
          expect(options.target).toEqual(daemonTarget);
          return fakeClient;
        },
      },
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input.scope).toBe("worktree");
    expect(archiveCalls[0]?.input.worktreePath).toBe(worktreePath);
  });

  it("throws a CommandError when the worktree is not found", async () => {
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [],
        error: null,
        requestId: "req-list",
      }),
    });

    await expect(
      runArchiveCommandWithDeps(
        "missing",
        { daemonTarget },
        {
          connectToDaemon: async (options) => {
            expect(options.target).toEqual(daemonTarget);
            return fakeClient;
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    });
  });
});

it("forwards the native backing generation and reports retained directories separately from archival", async () => {
  const generation = "a".repeat(64);
  let received: Parameters<DaemonClient["archivePaseoWorktree"]>[0] | undefined;
  const operationId = "00000000-0000-4000-8000-000000000001";
  const fake = createFakeDaemonClient({
    getPaseoWorktreeList: async () => ({
      worktrees: [
        {
          worktreePath: "/fixture/feature",
          createdAt: "2026-11-19T19:00:00.000Z",
          backingGeneration: generation,
        },
      ],
      error: null,
      requestId: "list",
    }),
    archivePaseoWorktree: async (input) => {
      received = input;
      return {
        success: true,
        removedAgents: [],
        removedDirectory: false,
        slotKept: true,
        retirement: { operationId, state: "complete" },
        error: null,
        requestId: "archive",
      };
    },
  });
  const result = await runArchiveCommandWithDeps(
    "feature",
    { daemonTarget },
    { connectToDaemon: async () => fake },
  );
  expect(received).toEqual({
    worktreePath: "/fixture/feature",
    scope: "worktree",
    expectedBackingGeneration: generation,
  });
  expect(result.data).toMatchObject({
    status: "archived",
    removedDirectory: false,
    slotKept: true,
    retirement: { operationId, state: "complete" },
  });
});

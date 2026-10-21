import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { render } from "../../output/index.js";
import { toWorkspaceRow, workspaceSchema, workspaceWithBackgroundSchema } from "./shared.js";

describe("workspace inventory output", () => {
  it("preserves nested placement and fractional sibling order in JSON output", () => {
    const descriptor = {
      id: "child",
      projectId: "project",
      projectDisplayName: "Project",
      projectRootPath: "/tmp/project",
      name: "Child",
      workspaceKind: "directory",
      projectKind: "directory",
      workspaceDirectory: "/tmp/project",
      parentWorkspaceId: "parent",
      siblingOrder: 1.5,
      status: "done",
      statusEnteredAt: null,
      archivingAt: null,
      activityAt: null,
      scripts: [],
      gitRuntime: null,
      githubRuntime: null,
    } satisfies WorkspaceDescriptorPayload;
    const result = {
      type: "single" as const,
      data: toWorkspaceRow(descriptor),
      schema: workspaceSchema,
    };
    expect(JSON.parse(render(result, { format: "json" }))).toMatchObject({
      workspaceId: "child",
      parentWorkspaceId: "parent",
      siblingOrder: 1.5,
    });
  });

  it.each([workspaceSchema, workspaceWithBackgroundSchema])(
    "preserves pinned, unpinned and unavailable metadata in structured output",
    (schema) => {
      const base = {
        projectDisplayName: "Project",
        name: "Workspace",
        workspaceKind: "local",
        workspaceDirectory: "/tmp/project",
      };
      const descriptors = [
        { ...base, id: "pinned", pinnedAt: "2026-10-16T20:00:00.000Z" },
        { ...base, id: "unpinned", pinnedAt: null, background: true },
        { ...base, id: "older-host" },
      ] as WorkspaceDescriptorPayload[];
      const result = { type: "list" as const, data: descriptors.map(toWorkspaceRow), schema };

      expect(JSON.parse(render(result, { format: "json" }))).toEqual([
        {
          workspaceId: "pinned",
          project: "Project",
          name: "Workspace",
          isolation: "local",
          cwd: "/tmp/project",
          background: false,
          pinnedAt: "2026-10-16T20:00:00.000Z",
        },
        {
          workspaceId: "unpinned",
          project: "Project",
          name: "Workspace",
          isolation: "local",
          cwd: "/tmp/project",
          background: true,
          pinnedAt: null,
        },
        {
          workspaceId: "older-host",
          project: "Project",
          name: "Workspace",
          isolation: "local",
          cwd: "/tmp/project",
          background: false,
        },
      ]);
      expect(render(result, { quiet: true })).toBe("pinned\nunpinned\nolder-host");
      const table = render(result, { noColor: true });
      expect(table).toContain("WORKSPACE ID");
      expect(table).not.toContain("2026-10-16");
    },
  );
});

it.each([null, "2026-10-18T00:00:00.000Z"])(
  "3fdb71dd7bc781c9964de0b6101b4e61@e93b9847d6fd#cli-store CLI JSON preserves explicit superpin %s",
  (superpinnedAt) => {
    const descriptor = {
      id: "workspace",
      projectDisplayName: "Project",
      name: "Workspace",
      workspaceKind: "directory",
      workspaceDirectory: "/tmp/project",
      pinnedAt: "2026-10-17T00:00:00.000Z",
      superpinnedAt,
    } as WorkspaceDescriptorPayload;
    const result = {
      type: "list" as const,
      data: [toWorkspaceRow(descriptor)],
      schema: workspaceSchema,
    };
    expect(JSON.parse(render(result, { format: "json" }))).toEqual([
      expect.objectContaining({ pinnedAt: descriptor.pinnedAt, superpinnedAt }),
    ]);
  },
);

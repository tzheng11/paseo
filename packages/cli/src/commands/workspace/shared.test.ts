import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { render } from "../../output/index.js";
import { toWorkspaceRow, workspaceSchema, workspaceWithBackgroundSchema } from "./shared.js";

describe("workspace inventory output", () => {
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

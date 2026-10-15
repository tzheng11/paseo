import { describe, expect, test } from "vitest";
import {
  WORKSPACE_FIELDS,
  isWorkspaceFieldKey,
  supportsWorkspaceFields,
  workspaceFieldValuesByteLength,
  assertWorkspaceFieldValues,
} from "./workspace-fields.js";

describe("fixed workspace fields", () => {
  test("uses one ordered catalogue and accepts only its stable keys", () => {
    expect(WORKSPACE_FIELDS).toEqual([
      { key: "notionProjectUrl", label: "Notion Project URL" },
      { key: "notionIssueUrl", label: "Notion Issue URL" },
    ]);
    expect(isWorkspaceFieldKey("notionIssueUrl")).toBe(true);
    expect(isWorkspaceFieldKey("__proto__")).toBe(false);
    expect(isWorkspaceFieldKey("other")).toBe(false);
  });
  test("requires the feature and matching catalogue version", () => {
    expect(
      supportsWorkspaceFields({
        features: { workspaceFields: true },
        workspaceFieldCatalogVersion: 1,
      }),
    ).toBe(true);
    expect(supportsWorkspaceFields({ features: {} })).toBe(false);
    expect(
      supportsWorkspaceFields({
        features: { workspaceFields: false },
        workspaceFieldCatalogVersion: 1,
      }),
    ).toBe(false);
    expect(
      supportsWorkspaceFields({
        features: { workspaceFields: true },
        workspaceFieldCatalogVersion: 2,
      }),
    ).toBe(false);
  });
  test("bounds UTF-8 JSON bytes including escaping at the exact aggregate limit", () => {
    const value = "\u0000".repeat(5000);
    const exact = {
      notionProjectUrl:
        value + "a".repeat(32768 - workspaceFieldValuesByteLength({ notionProjectUrl: value })),
    };
    expect(workspaceFieldValuesByteLength(exact)).toBe(32768);
    expect(() => assertWorkspaceFieldValues(exact)).not.toThrow();
    expect(() =>
      assertWorkspaceFieldValues({ notionProjectUrl: exact.notionProjectUrl + "a" }),
    ).toThrow("too large");
    expect(workspaceFieldValuesByteLength({ notionIssueUrl: "☃" })).toBe(
      new TextEncoder().encode(JSON.stringify({ notionIssueUrl: "☃" })).length,
    );
    expect(() => assertWorkspaceFieldValues({ notionIssueUrl: "a".repeat(8001) })).toThrow("8,000");
  });
  test("bounds a full 200-workspace page below the socket budget", () => {
    const value = "\u0000".repeat(5000);
    const map = {
      notionProjectUrl:
        value + "a".repeat(32768 - workspaceFieldValuesByteLength({ notionProjectUrl: value })),
    };
    const entries = Array.from({ length: 200 }, (_, id) => ({
      id: `workspace-${id}`,
      projectId: "project",
      projectDisplayName: "Project",
      projectRootPath: "/tmp/project",
      workspaceKind: "directory",
      projectKind: "non_git",
      name: "Workspace",
      status: "done",
      activityAt: null,
      diffStat: null,
      fieldValues: map,
    }));
    expect(
      entries.reduce(
        (bytes, entry) => bytes + workspaceFieldValuesByteLength(entry.fieldValues),
        0,
      ),
    ).toBe(6553600);
    expect(
      new TextEncoder().encode(
        JSON.stringify({
          type: "fetch_workspaces_response",
          payload: {
            requestId: "budget",
            entries,
            pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
          },
        }),
      ).length,
    ).toBeLessThan(8 * 1024 * 1024);
  });
});

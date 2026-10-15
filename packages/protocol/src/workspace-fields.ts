/** The same immutable field definitions are used by every client and daemon. */
export const WORKSPACE_FIELDS = [
  { key: "notionProjectUrl", label: "Notion Project URL" },
  { key: "notionIssueUrl", label: "Notion Issue URL" },
] as const;

export type WorkspaceFieldKey = (typeof WORKSPACE_FIELDS)[number]["key"];
export const WORKSPACE_FIELD_CATALOG_VERSION = 1;
export const MAX_WORKSPACE_FIELD_VALUE_LENGTH = 8_000;
export const MAX_WORKSPACE_FIELD_VALUES_BYTES = 32 * 1024;

export function isWorkspaceFieldKey(key: string): key is WorkspaceFieldKey {
  return WORKSPACE_FIELDS.some((field) => field.key === key);
}

export function supportsWorkspaceFields(
  info:
    | {
        features?: { workspaceFields?: boolean };
        workspaceFieldCatalogVersion?: number;
      }
    | null
    | undefined,
): boolean {
  return (
    info?.features?.workspaceFields === true &&
    info.workspaceFieldCatalogVersion === WORKSPACE_FIELD_CATALOG_VERSION
  );
}

export type WorkspaceFieldErrorCode = "invalid_value" | "unknown_field" | "not_found" | "conflict";

export class WorkspaceFieldError extends Error {
  constructor(
    public readonly code: WorkspaceFieldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFieldError";
  }
}

export function workspaceFieldValuesByteLength(values: Record<string, string>): number {
  return new TextEncoder().encode(JSON.stringify(values)).byteLength;
}

export function assertWorkspaceFieldValues(values: Record<string, string>): void {
  if (Object.values(values).some((value) => value.length > MAX_WORKSPACE_FIELD_VALUE_LENGTH)) {
    throw new WorkspaceFieldError("invalid_value", "Each field is limited to 8,000 characters.");
  }
  if (workspaceFieldValuesByteLength(values) > MAX_WORKSPACE_FIELD_VALUES_BYTES) {
    throw new WorkspaceFieldError(
      "invalid_value",
      "Workspace fields are too large (32 KiB maximum). Shorten the text and retry.",
    );
  }
}

import {
  assertWorkspaceFieldValues,
  isWorkspaceFieldKey,
  WorkspaceFieldError,
} from "@getpaseo/protocol/workspace-fields";
import type { WorkspaceRegistry } from "./workspace-registry.js";

/** Compare and merge inside the registry's serialized, atomic transaction. */
export async function setWorkspaceFieldValue(
  registry: WorkspaceRegistry,
  input: {
    workspaceId: string;
    fieldKey: string;
    value: string;
    expectedValue: string;
  },
): Promise<string> {
  const { workspaceId, fieldKey, value, expectedValue } = input;
  if (!isWorkspaceFieldKey(fieldKey)) {
    throw new WorkspaceFieldError("unknown_field", "Unknown workspace field.");
  }
  assertWorkspaceFieldValues({ [fieldKey]: value });
  const updated = await registry.update(workspaceId, (existing) => {
    if (existing.archivedAt) throw new WorkspaceFieldError("not_found", "Workspace is archived.");
    const current = existing.fieldValues?.[fieldKey] ?? "";
    if (current === value) return existing;
    if (current !== expectedValue) {
      throw new WorkspaceFieldError(
        "conflict",
        "This field changed in another client. Your draft is kept. Cancel and reopen the field to edit its latest value.",
      );
    }
    const fieldValues = { ...existing.fieldValues, [fieldKey]: value };
    assertWorkspaceFieldValues(fieldValues);
    return { ...existing, fieldValues, updatedAt: new Date().toISOString() };
  });
  if (!updated) throw new WorkspaceFieldError("not_found", "Workspace not found.");
  return updated.fieldValues?.[fieldKey] ?? "";
}

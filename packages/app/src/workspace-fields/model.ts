import {
  supportsWorkspaceFields,
  WorkspaceFieldError,
  type WorkspaceFieldKey,
} from "@getpaseo/protocol/workspace-fields";

export type WorkspaceFieldsAvailability = "loading" | "update" | "readOnly" | "offline" | "ready";
export function workspaceFieldsAvailability(
  info:
    | {
        features?: { workspaceFields?: boolean };
        workspaceFieldCatalogVersion?: number;
        permissions?: readonly string[];
      }
    | null
    | undefined,
  connected: boolean,
  valuesLoaded = true,
): WorkspaceFieldsAvailability {
  if (!info) return "loading";
  if (!supportsWorkspaceFields(info)) return "update";
  if (!connected) return "offline";
  if (!valuesLoaded) return "loading";
  if (!info.permissions?.includes("workspace.manage")) return "readOnly";
  return "ready";
}
export interface FieldEditor {
  key: WorkspaceFieldKey;
  draft: string;
  expectedValue: string;
  status: "editing" | "saving" | "error";
  error: string | null;
  conflict: boolean;
}
export interface FieldsSnapshot {
  values: Record<string, string>;
  availability: WorkspaceFieldsAvailability;
  hasValues: boolean;
  editor: FieldEditor | null;
}
export class WorkspaceFieldsModel {
  private editedValueRevision = 0;
  private state: FieldsSnapshot;
  private listeners = new Set<() => void>();
  constructor(
    private readonly commit: (input: {
      fieldKey: WorkspaceFieldKey;
      value: string;
      expectedValue: string;
    }) => Promise<{ value: string }>,
    initial?: { values: Record<string, string> | null; availability: WorkspaceFieldsAvailability },
  ) {
    this.state = {
      values: initial?.values ?? {},
      hasValues: initial?.values != null,
      availability: initial?.availability ?? "loading",
      editor: null,
    };
  }
  snapshot = (): FieldsSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: FieldsSnapshot): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  receive(values: Record<string, string> | null, availability: WorkspaceFieldsAvailability): void {
    const key = this.state.editor?.key;
    if (values && key && (values[key] ?? "") !== (this.state.values[key] ?? "")) {
      this.editedValueRevision++;
    }
    this.publish({
      ...this.state,
      values: values ?? this.state.values,
      hasValues: values !== null || this.state.hasValues,
      availability,
    });
  }
  edit(key: WorkspaceFieldKey): void {
    if (!this.state.hasValues || this.state.availability !== "ready" || this.state.editor !== null)
      return;
    const current = this.state.values[key] ?? "";
    this.publish({
      ...this.state,
      editor: {
        key,
        draft: current,
        expectedValue: current,
        status: "editing",
        error: null,
        conflict: false,
      },
    });
  }
  change(draft: string): void {
    const editor = this.state.editor;
    if (!editor || editor.status === "saving") return;
    this.publish({ ...this.state, editor: { ...editor, draft } });
  }
  cancel(): void {
    if (this.state.editor?.status === "saving") return;
    this.publish({ ...this.state, editor: null });
  }
  async save(): Promise<void> {
    const editor = this.state.editor;
    if (!editor || editor.status === "saving") return;
    if (this.state.availability !== "ready") {
      this.publish({
        ...this.state,
        editor: { ...editor, status: "error", error: this.state.availability },
      });
      return;
    }
    const valueRevision = this.editedValueRevision;
    this.publish({ ...this.state, editor: { ...editor, status: "saving", error: null } });
    try {
      const { value } = await this.commit({
        fieldKey: editor.key,
        value: editor.draft,
        expectedValue: editor.expectedValue,
      });
      this.publish({
        ...this.state,
        // A delayed acknowledgement must not replace a subsequent authoritative edit.
        values:
          valueRevision === this.editedValueRevision
            ? { ...this.state.values, [editor.key]: value }
            : this.state.values,
        editor: null,
      });
    } catch (error) {
      this.publish({
        ...this.state,
        editor: {
          ...editor,
          status: "error",
          error: error instanceof Error ? error.message : "Unable to save workspace field.",
          conflict: error instanceof WorkspaceFieldError && error.code === "conflict",
        },
      });
    }
  }
}

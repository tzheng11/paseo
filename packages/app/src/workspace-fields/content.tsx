import { useCallback } from "react";
import { type WorkspaceFieldsModel, type FieldsSnapshot } from "./model";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  WORKSPACE_FIELDS,
  MAX_WORKSPACE_FIELD_VALUE_LENGTH,
} from "@getpaseo/protocol/workspace-fields";
import { FormTextInput } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { useWorkspaceFieldsModel } from "./use-workspace-fields-model";

export function WorkspaceFieldsContent(props: { serverId: string; workspaceId: string }) {
  const { t } = useTranslation();
  const { model, state } = useWorkspaceFieldsModel(props.serverId, props.workspaceId);
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="workspace-info-content"
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading}>{t("panels.info.fields")}</Text>
      {state.availability !== "ready" ? (
        <Text style={styles.hint} testID="workspace-info-availability">
          {t(`panels.info.${state.availability}`)}
        </Text>
      ) : null}
      {WORKSPACE_FIELDS.map((field) => (
        <WorkspaceFieldRow key={field.key} field={field} model={model} state={state} />
      ))}
    </ScrollView>
  );
}
function WorkspaceFieldRow({
  field,
  model,
  state,
}: {
  field: (typeof WORKSPACE_FIELDS)[number];
  model: WorkspaceFieldsModel;
  state: FieldsSnapshot;
}) {
  const { t } = useTranslation();
  const editor = state.editor?.key === field.key ? state.editor : null;
  const pending = state.editor?.status === "saving";
  const canRead = state.availability !== "loading" && state.availability !== "update";
  const edit = useCallback(() => model.edit(field.key), [model, field.key]);
  const change = useCallback((draft: string) => model.change(draft), [model]);
  const save = useCallback(() => {
    void model.save();
  }, [model]);
  const cancel = useCallback(() => model.cancel(), [model]);
  let saveLabel = t("panels.info.save");
  if (pending) saveLabel = t("panels.info.saving");
  else if (editor?.error) saveLabel = t("panels.info.retry");
  let error = editor?.error;
  if (error === "offline") error = t("panels.info.offline");
  if (editor?.conflict) error = t("panels.info.conflict");
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={field.label}
        disabled={state.availability !== "ready" || state.editor !== null}
        onPress={edit}
        style={styles.row}
        testID={`workspace-info-field-${field.key}`}
      >
        <Text style={styles.label}>{field.label}</Text>
        <Text style={styles.value} numberOfLines={4} testID={`workspace-info-value-${field.key}`}>
          {canRead
            ? state.values[field.key] || t("panels.info.empty")
            : t("panels.info.unavailable")}
        </Text>
      </Pressable>
      {editor ? (
        <View style={styles.editor}>
          <FormTextInput
            key={field.key}
            initialValue={editor.draft}
            onChangeText={change}
            multiline
            autoFocus
            editable={!pending}
            maxLength={MAX_WORKSPACE_FIELD_VALUE_LENGTH}
            accessibilityLabel={field.label}
            testID="workspace-info-input"
            style={styles.input}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.error} testID="workspace-info-error">
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              size="sm"
              onPress={save}
              disabled={pending}
              loading={pending}
              testID="workspace-info-save"
            >
              {saveLabel}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={cancel}
              disabled={pending}
              testID="workspace-info-cancel"
            >
              {t("panels.info.cancel")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minWidth: 0 },
  content: { paddingVertical: theme.spacing[4] },
  heading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[3],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  label: {
    width: 144,
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  value: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  editor: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[3],
  },
  input: { minHeight: 140, maxHeight: 320, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));

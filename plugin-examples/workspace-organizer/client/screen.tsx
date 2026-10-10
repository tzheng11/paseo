import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSettings, type PluginScreenProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import {
  descendants,
  moveNode,
  newId,
  organization,
  organizationSchema,
  projectLinkSchema,
  removeNode,
  updateNode,
  workspaceIdentity,
  type OrganizationNode,
} from "../shared/organization";
import { useWorkspaceChoices } from "./workspaces";

type ReadySettings = Extract<SettingsState<typeof organizationSchema>, { status: "ready" }>;
type Theme = PluginScreenProps["theme"];
const styles = StyleSheet.create({
  nested: { marginLeft: 16 },
  link: { padding: 12, gap: 4 },
  container: { padding: 16 },
  content: { padding: 16, gap: 20, maxWidth: 900, width: "100%", alignSelf: "center" },
});
function useColors(theme: Theme) {
  return useMemo(
    () => ({
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      accent: { color: theme.colors.accent },
      refresh: { color: theme.colors.accent, padding: 8 },
      notice: { color: theme.colors.foregroundMuted, padding: 12, lineHeight: 20 },
    }),
    [theme],
  );
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Notice({
  children,
  theme,
  alert = false,
}: {
  children: ReactNode;
  theme: Theme;
  alert?: boolean;
}) {
  const colors = useColors(theme);
  return (
    <Text accessibilityRole={alert ? "alert" : undefined} style={colors.notice}>
      {children}
    </Text>
  );
}

interface TreeProps {
  nodes: OrganizationNode[];
  parentId?: string | null;
  selected: string | null;
  onSelect(id: string): void;
  theme: Theme;
}
function TreeEntry({ node, ...props }: TreeProps & { node: OrganizationNode }) {
  const { selected, onSelect, theme } = props;
  const colors = useColors(theme);
  const select = useCallback(() => onSelect(node.id), [onSelect, node.id]);
  const state = useMemo(() => ({ selected: selected === node.id }), [selected, node.id]);
  const style = useMemo(
    () => ({
      padding: 12,
      borderRadius: 6,
      backgroundColor: selected === node.id ? theme.colors.surface2 : theme.colors.surface0,
    }),
    [selected, node.id, theme],
  );
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit ${node.title}`}
        accessibilityState={state}
        onPress={select}
        style={style}
      >
        <Text numberOfLines={1} style={colors.text}>
          {node.kind === "folder" ? "▾ " : "▣ "}
          {node.title}
        </Text>
        {node.links.length ? (
          <Text style={colors.muted}>
            {node.links.length} project {node.links.length === 1 ? "link" : "links"}
          </Text>
        ) : null}
      </Pressable>
      <View style={styles.nested}>
        <Tree {...props} parentId={node.id} />
      </View>
    </View>
  );
}
function Tree({ parentId = null, ...props }: TreeProps) {
  return (
    <View>
      {props.nodes
        .filter((node) => node.parentId === parentId)
        .map((node) => (
          <TreeEntry key={node.id} {...props} node={node} />
        ))}
    </View>
  );
}

function ProjectLinkRow({
  link,
  theme,
  disabled,
  onRemove,
}: {
  link: OrganizationNode["links"][number];
  theme: Theme;
  disabled: boolean;
  onRemove(id: string): void;
}) {
  const colors = useColors(theme);
  const remove = useCallback(() => onRemove(link.id), [onRemove, link.id]);
  return (
    <View style={styles.link}>
      <ExternalLink href={link.url} accessibilityLabel={`Open ${link.title}`}>
        <Text style={colors.accent}>{link.title}</Text>
      </ExternalLink>
      <Text numberOfLines={1} style={colors.muted}>
        {link.url}
      </Text>
      <SettingsAction
        label={link.title}
        actionLabel={`Remove link ${link.title}`}
        disabled={disabled}
        onPress={remove}
      />
    </View>
  );
}

function NodeEditor({
  settings,
  nodeId,
  onClose,
  theme,
  navigation,
}: {
  settings: ReadySettings;
  nodeId: string;
  onClose(): void;
  theme: Theme;
  navigation: PluginScreenProps["navigation"];
}) {
  // Keep both the document and its revision until this draft is saved or explicitly discarded.
  const [draft, setDraft] = useState(() => ({
    document: settings.values,
    revision: settings.revision,
  }));
  const [error, setError] = useState<string | null>(null);
  const [linkTitle, setLinkTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkForm, setLinkForm] = useState(0);
  const node = draft.document.nodes.find((entry) => entry.id === nodeId);
  const parents = useMemo(() => {
    const excluded = descendants(draft.document.nodes, nodeId);
    return [
      { label: "Top level", value: "" },
      ...draft.document.nodes
        .filter((candidate) => !excluded.has(candidate.id))
        .map((candidate) => ({ label: candidate.title, value: candidate.id })),
    ];
  }, [draft.document.nodes, nodeId]);
  const changeDocument = useCallback(
    (update: () => typeof draft.document) => {
      try {
        const document = update();
        setDraft({ ...draft, document });
        setError(null);
        return true;
      } catch (failure) {
        setError(message(failure));
        return false;
      }
    },
    [draft],
  );
  const changeNode = useCallback(
    (next: OrganizationNode) => changeDocument(() => updateNode(draft.document, next)),
    [changeDocument, draft.document],
  );
  const save = useCallback(
    async (document = draft.document) => {
      setError(null);
      if (await settings.save(document, draft.revision)) onClose();
    },
    [draft, settings, onClose],
  );
  const saveDraft = useCallback(() => {
    void save();
  }, [save]);
  const discard = useCallback(() => {
    onClose();
    void settings.reload();
  }, [onClose, settings]);
  const remove = useCallback(() => {
    try {
      void save(removeNode(draft.document, nodeId));
    } catch (failure) {
      setError(message(failure));
    }
  }, [save, draft.document, nodeId]);
  const moveUp = useCallback(
    () => changeDocument(() => moveNode(draft.document, nodeId, -1)),
    [changeDocument, draft.document, nodeId],
  );
  const moveDown = useCallback(
    () => changeDocument(() => moveNode(draft.document, nodeId, 1)),
    [changeDocument, draft.document, nodeId],
  );
  const rename = useCallback(
    (title: string) =>
      setDraft((current) => ({
        ...current,
        document: {
          nodes: current.document.nodes.map((entry) =>
            entry.id === nodeId ? Object.assign({}, entry, { title }) : entry,
          ),
        },
      })),
    [nodeId],
  );
  const reparent = useCallback(
    (parentId: string) => {
      if (node) changeNode({ ...node, parentId: parentId || null });
    },
    [node, changeNode],
  );
  const open = useCallback(() => {
    if (node?.kind === "workspace")
      navigation?.openWorkspace({ serverId: node.serverId, workspaceId: node.workspaceId });
  }, [node, navigation]);
  const removeLink = useCallback(
    (id: string) => {
      if (node) changeNode({ ...node, links: node.links.filter((link) => link.id !== id) });
    },
    [node, changeNode],
  );
  const addLink = useCallback(() => {
    if (!node) return;
    const result = projectLinkSchema.safeParse({ id: newId(), title: linkTitle, url: linkUrl });
    if (!result.success) {
      setError(result.error.issues.map((issue) => issue.message).join("\n"));
      return;
    }
    if (changeNode({ ...node, links: [...node.links, result.data] })) {
      setLinkTitle("");
      setLinkUrl("");
      setLinkForm((value) => value + 1);
    }
  }, [node, linkTitle, linkUrl, changeNode]);
  if (!node) return null;
  return (
    <SettingsSection title={`Edit ${node.title}`} testID="organizer-editor">
      <SettingsCard>
        <SettingsInput
          label="Entry name"
          testID="organizer-entry-name"
          initialValue={node.title}
          onChangeText={rename}
          disabled={settings.saving}
        />
        <SettingsSelect
          label="Nested inside"
          value={node.parentId ?? ""}
          options={parents}
          disabled={settings.saving}
          onValueChange={reparent}
        />
        <SettingsAction
          label="Sibling order"
          actionLabel="Move up"
          disabled={settings.saving}
          onPress={moveUp}
        />
        <SettingsAction
          label="Sibling order"
          actionLabel="Move down"
          disabled={settings.saving}
          onPress={moveDown}
        />
        {node.kind === "workspace" && navigation ? (
          <SettingsAction label="Workspace" actionLabel="Open workspace" onPress={open} />
        ) : null}
      </SettingsCard>
      <SettingsCard>
        {node.links.map((link) => (
          <ProjectLinkRow
            key={link.id}
            link={link}
            theme={theme}
            disabled={settings.saving}
            onRemove={removeLink}
          />
        ))}
        <View key={linkForm}>
          <SettingsInput
            label="Link name"
            testID="organizer-link-name"
            placeholder="Notion project"
            onChangeText={setLinkTitle}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Project URL"
            testID="organizer-link-url"
            placeholder="https://www.notion.so/…"
            onChangeText={setLinkUrl}
            disabled={settings.saving}
          />
        </View>
        <SettingsAction
          label="Notion or other project link"
          actionLabel="Add link to draft"
          disabled={settings.saving}
          onPress={addLink}
        />
      </SettingsCard>
      <Notice theme={theme}>
        Changes below are saved together. Removing an entry keeps its workspaces and promotes its
        nested entries.
      </Notice>
      {error || settings.saveError ? (
        <Notice theme={theme} alert>
          {error ?? settings.saveError}
        </Notice>
      ) : null}
      <SettingsCard>
        <SettingsAction
          label="Shared organization"
          actionLabel="Save changes"
          disabled={settings.saving}
          onPress={saveDraft}
        />
        <SettingsAction
          label="Unsaved changes"
          actionLabel="Discard changes"
          disabled={settings.saving}
          onPress={discard}
        />
        <SettingsAction
          label="Navigation reference"
          actionLabel="Remove from organization"
          disabled={settings.saving}
          onPress={remove}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function OrganizationEditor({
  settings,
  theme,
  host,
  params,
  navigation,
}: PluginScreenProps & { settings: ReadySettings }) {
  const [selected, setSelected] = useState<string | null>(() => params.node ?? null);
  const [folderName, setFolderName] = useState("");
  const [folderForm, setFolderForm] = useState(0);
  const [parentId, setParentId] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const catalog = useWorkspaceChoices();
  const document = settings.values;
  const parent = document.nodes.some((node) => node.id === parentId) ? parentId : "";
  const parents = useMemo(
    () => [
      { label: "Top level", value: "" },
      ...document.nodes.map((node) => ({ label: node.title, value: node.id })),
    ],
    [document.nodes],
  );
  const added = new Set(
    document.nodes.flatMap((node) =>
      node.kind === "workspace" ? [workspaceIdentity(node.serverId, node.workspaceId)] : [],
    ),
  );
  const choices = catalog.choices.filter(
    ({ serverId, workspace, hostLabel }) =>
      !added.has(workspaceIdentity(serverId, workspace.id)) &&
      `${workspace.name} ${workspace.projectDisplayName} ${hostLabel}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const addNode = useCallback(
    async (node: OrganizationNode) => {
      try {
        setError(null);
        const next = organizationSchema.parse({ nodes: [...document.nodes, node] });
        if (await settings.save(next, settings.revision)) {
          setFolderName("");
          setFolderForm((value) => value + 1);
        }
      } catch (failure) {
        setError(message(failure));
      }
    },
    [document, settings],
  );
  const select = useCallback((id: string) => {
    setSelected(id);
    setError(null);
  }, []);
  const closeEditor = useCallback(() => setSelected(null), []);
  const reload = useCallback(() => {
    setSelected(null);
    void settings.reload();
  }, [settings]);
  const createFolder = useCallback(() => {
    void addNode({
      id: newId(),
      kind: "folder",
      title: folderName,
      parentId: parent || null,
      links: [],
    });
  }, [addNode, folderName, parent]);
  const colors = useColors(theme);
  const refreshButton = useMemo(
    () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh workspaces"
        onPress={catalog.refresh}
      >
        <Text style={colors.refresh}>Refresh</Text>
      </Pressable>
    ),
    [catalog.refresh, colors],
  );
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Notice theme={theme}>
        Shared through {host.label}. Nest folders or workspaces, set their order, and attach Notion
        project links. Workspace files stay on their original hosts.
      </Notice>
      <SettingsSection title="Your organization">
        <SettingsCard>
          {document.nodes.length ? (
            <Tree nodes={document.nodes} selected={selected} onSelect={select} theme={theme} />
          ) : (
            <Notice theme={theme}>Start with a folder or add a workspace below.</Notice>
          )}
        </SettingsCard>
        <SettingsAction
          label="Changes from other clients"
          actionLabel="Reload organization"
          disabled={settings.saving}
          onPress={reload}
        />
      </SettingsSection>
      {selected ? (
        <NodeEditor
          key={selected}
          settings={settings}
          nodeId={selected}
          onClose={closeEditor}
          theme={theme}
          navigation={navigation}
        />
      ) : null}
      {error || (!selected && settings.saveError) ? (
        <Notice theme={theme} alert>
          {error ?? settings.saveError}
        </Notice>
      ) : null}
      <SettingsSection title="Add to organization">
        <SettingsCard>
          <SettingsSelect
            label="Add inside"
            value={parent}
            options={parents}
            disabled={settings.saving}
            onValueChange={setParentId}
          />
          <View key={folderForm}>
            <SettingsInput
              label="Folder name"
              testID="organizer-folder-name"
              placeholder="Project or group name"
              onChangeText={setFolderName}
              disabled={settings.saving}
            />
          </View>
          <SettingsAction
            label="New folder"
            actionLabel="Create folder"
            disabled={settings.saving || !folderName.trim()}
            onPress={createFolder}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Existing workspaces" trailing={refreshButton}>
        <SettingsCard>
          <SettingsInput
            label="Find workspace"
            testID="organizer-workspace-search"
            placeholder="Name, project or host"
            onChangeText={setQuery}
          />
          {catalog.loading ? <Notice theme={theme}>Loading paired hosts…</Notice> : null}
          {catalog.errors.map((failure) => (
            <Notice key={failure} theme={theme} alert>
              {failure}
            </Notice>
          ))}
          {!catalog.loading && !choices.length ? (
            <Notice theme={theme}>No matching unlinked workspaces on online hosts.</Notice>
          ) : null}
          {choices.map((choice) => (
            <WorkspaceChoiceRow
              key={workspaceIdentity(choice.serverId, choice.workspace.id)}
              choice={choice}
              parentId={parent || null}
              saving={settings.saving}
              onAdd={addNode}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}

function WorkspaceChoiceRow({
  choice,
  parentId,
  saving,
  onAdd,
}: {
  choice: ReturnType<typeof useWorkspaceChoices>["choices"][number];
  parentId: string | null;
  saving: boolean;
  onAdd(node: OrganizationNode): Promise<void>;
}) {
  const { serverId, workspace, hostLabel } = choice;
  const add = useCallback(() => {
    void onAdd({
      id: newId(),
      kind: "workspace",
      title: workspace.name,
      serverId,
      workspaceId: workspace.id,
      parentId,
      links: [],
    });
  }, [onAdd, workspace, serverId, parentId]);
  return (
    <SettingsAction
      label={`${workspace.name} · ${hostLabel}`}
      hint={workspace.projectDisplayName}
      actionLabel={`Add ${workspace.name} from ${hostLabel}`}
      disabled={saving}
      onPress={add}
    />
  );
}

export function OrganizationScreen(props: PluginScreenProps) {
  const settings = useSettings(organization);
  const retry = useCallback(() => {
    void settings.reload();
  }, [settings]);
  if (settings.status !== "ready")
    return (
      <View style={styles.container}>
        <Notice theme={props.theme} alert={settings.status !== "loading"}>
          {settings.status === "loading" ? "Loading shared organization…" : settings.error}
        </Notice>
        {settings.status !== "loading" ? (
          <SettingsAction
            label="Saved data is preserved"
            actionLabel="Retry organization"
            onPress={retry}
          />
        ) : null}
      </View>
    );
  return <OrganizationEditor {...props} settings={settings} />;
}

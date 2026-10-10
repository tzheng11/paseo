import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  openExternalUrl,
  useHosts,
  useSettings,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import {
  SidebarRow,
  SortableTree,
  type SortableTreeMove,
  type SortableTreeProps,
} from "@getpaseo/plugin/client/ui";
import {
  organization,
  relocateNode,
  type OrganizationNode,
  type ProjectLink,
} from "../shared/organization";

const styles = StyleSheet.create({
  nested: { marginLeft: 12 },
  toggle: { padding: 8 },
  trailing: { flexDirection: "row", alignItems: "center" },
});
const emptyNodes: OrganizationNode[] = [];

function LinkRow({
  link,
  nodeId,
  onError,
}: {
  link: ProjectLink;
  nodeId: string;
  onError(error: string): void;
}) {
  const open = useCallback(() => {
    void openExternalUrl(link.url).catch((failure: unknown) => onError(String(failure)));
  }, [link.url, onError]);
  return (
    <View style={styles.nested}>
      <SidebarRow
        id={`link-${nodeId}-${link.id}`}
        icon="ExternalLink"
        label={link.title}
        onPress={open}
      />
    </View>
  );
}

function NodeRow({
  node,
  collapsed,
  onToggle,
  dragHandle,
  props,
  onError,
}: {
  node: OrganizationNode;
  collapsed: boolean;
  onToggle(id: string): void;
  dragHandle?: ReactNode;
  props: PluginSidebarItemProps;
  onError(error: string | null): void;
}) {
  const hosts = useHosts();
  const { theme, navigation, openScreen } = props;
  const host =
    node.kind === "workspace" ? hosts.find((entry) => entry.serverId === node.serverId) : null;
  const offline = node.kind === "workspace" && host?.status !== "online";
  const hasChildren = node.kind === "folder" || node.links.length > 0;
  const toggle = useCallback(() => onToggle(node.id), [onToggle, node.id]);
  const open = useCallback(() => {
    onError(null);
    if (node.kind === "folder") {
      toggle();
      return;
    }
    if (offline) {
      onError(`${host?.label ?? node.serverId} is offline. The workspace remains linked.`);
      return;
    }
    if (navigation)
      navigation.openWorkspace({ serverId: node.serverId, workspaceId: node.workspaceId });
    else openScreen({ screenId: "organization", params: { node: node.id } });
  }, [onError, node, toggle, offline, host, navigation, openScreen]);
  const textStyle = useMemo(
    () => ({ color: theme.colors.foregroundMuted, fontSize: 12, paddingHorizontal: 12 }),
    [theme],
  );
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        {dragHandle}
        {hasChildren ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${node.title}`}
            onPress={toggle}
            style={styles.toggle}
          >
            <Text style={textStyle}>{collapsed ? "▸" : "▾"}</Text>
          </Pressable>
        ) : null}
      </View>
    ),
    [dragHandle, hasChildren, collapsed, node.title, toggle, textStyle],
  );
  return (
    <View>
      <SidebarRow
        id={`node-${node.id}`}
        label={node.title}
        icon={node.kind === "folder" ? "Folder" : "PanelsTopLeft"}
        onPress={open}
        trailing={trailing}
      />
      {node.kind === "workspace" ? (
        <Text style={textStyle}>
          {host?.label ?? node.serverId}
          {offline ? " · offline" : ""}
        </Text>
      ) : null}
      {!collapsed ? (
        <View style={styles.nested}>
          {node.links.map((link) => (
            <LinkRow key={link.id} link={link} nodeId={node.id} onError={onError} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function OrganizationSidebar(props: PluginSidebarItemProps) {
  const settings = useSettings(organization);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const { theme, openScreen } = props;
  const open = useCallback(() => openScreen({ screenId: "organization" }), [openScreen]);
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted, padding: 12 }), [theme]);
  const toggle = useCallback(
    (id: string) => setCollapsed((current) => ({ ...current, [id]: !current[id] })),
    [],
  );
  const move = useCallback(
    (input: SortableTreeMove) => {
      if (settings.status !== "ready" || settings.saving) return;
      setError(null);
      void (async () => {
        try {
          const next = relocateNode(settings.values, input);
          if (JSON.stringify(next) === JSON.stringify(settings.values)) return;
          if (await settings.save(next, settings.revision)) {
            if (input.parentId)
              setCollapsed((current) => ({ ...current, [input.parentId!]: false }));
          } else setError("The move was not saved. Reload the organization and try again.");
        } catch (failure) {
          setError(String(failure));
        }
      })();
    },
    [settings],
  );
  const renderNode = useCallback(
    (node: OrganizationNode, dragHandle?: ReactNode) => (
      <NodeRow
        node={node}
        collapsed={!!collapsed[node.id]}
        onToggle={toggle}
        dragHandle={dragHandle}
        props={props}
        onError={setError}
      />
    ),
    [collapsed, toggle, props],
  );
  const nodes = settings.status === "ready" ? settings.values.nodes : emptyNodes;
  const items = useMemo(
    () =>
      nodes.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        label: node.title,
        acceptsChildren: node.kind === "folder",
        collapsed: !!collapsed[node.id],
      })),
    [nodes, collapsed],
  );
  const colors = useMemo(
    () => ({
      accent: theme.colors.accent,
      muted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      background: theme.colors.surface1,
      foreground: theme.colors.foreground,
    }),
    [theme],
  );
  const renderItem = useCallback<SortableTreeProps["renderItem"]>(
    ({ id, dragHandle }) => renderNode(nodes.find((node) => node.id === id)!, dragHandle),
    [nodes, renderNode],
  );
  const plainTree = (parentId: string | null): ReactNode =>
    nodes
      .filter((node) => node.parentId === parentId)
      .map((node) => (
        <Fragment key={node.id}>
          {renderNode(node)}
          {!collapsed[node.id] ? <View style={styles.nested}>{plainTree(node.id)}</View> : null}
        </Fragment>
      ));
  let content: ReactNode;
  if (settings.status !== "ready")
    content = (
      <Text style={textStyle}>
        {settings.status === "loading" ? "Loading organization…" : "Organization unavailable"}
      </Text>
    );
  else if (props.layout.platform !== "web") content = plainTree(null);
  // COMPAT(sortable-plugin-tree): added in fork v0.11.2; remove after 2027-01-01.
  else if (!SortableTree)
    content = (
      <Text style={textStyle}>
        Update this client to the matching fork build to use pinned folders.
      </Text>
    );
  else
    content = (
      <SortableTree
        testID="organizer-sidebar-tree"
        items={items}
        colors={colors}
        disabled={settings.saving}
        onMove={move}
        renderItem={renderItem}
      />
    );
  return (
    <>
      <SidebarRow id="manage" icon="FolderTree" label="Organize pinned folders" onPress={open} />
      <View>{content}</View>
      {error || settings.saveError ? (
        <Text accessibilityRole="alert" style={textStyle}>
          {settings.saveError ?? error}
        </Text>
      ) : null}
    </>
  );
}

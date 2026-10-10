import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  openExternalUrl,
  useHosts,
  useSettings,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { organization, type OrganizationNode, type ProjectLink } from "../shared/organization";

const styles = StyleSheet.create({
  nested: { marginLeft: 12 },
  toggle: { padding: 8 },
});

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
  nodes,
  props,
  onError,
}: {
  node: OrganizationNode;
  nodes: OrganizationNode[];
  props: PluginSidebarItemProps;
  onError(error: string | null): void;
}) {
  const hosts = useHosts();
  const [collapsed, setCollapsed] = useState(false);
  const { theme, navigation, openScreen } = props;
  const host =
    node.kind === "workspace" ? hosts.find((entry) => entry.serverId === node.serverId) : null;
  const offline = node.kind === "workspace" && host?.status !== "online";
  const children = nodes.filter((child) => child.parentId === node.id);
  const hasChildren = node.kind === "folder" || node.links.length > 0;
  const toggle = useCallback(() => setCollapsed((current) => !current), []);
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
    () =>
      hasChildren ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${node.title}`}
          onPress={toggle}
          style={styles.toggle}
        >
          <Text style={textStyle}>{collapsed ? "▸" : "▾"}</Text>
        </Pressable>
      ) : undefined,
    [hasChildren, collapsed, node.title, toggle, textStyle],
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
          {children.map((child) => (
            <NodeRow key={child.id} node={child} nodes={nodes} props={props} onError={onError} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function OrganizationSidebar(props: PluginSidebarItemProps) {
  const settings = useSettings(organization);
  const [error, setError] = useState<string | null>(null);
  const { theme, openScreen } = props;
  const open = useCallback(() => openScreen({ screenId: "organization" }), [openScreen]);
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted, padding: 12 }), [theme]);
  return (
    <>
      <SidebarRow id="manage" icon="FolderTree" label="Organize pinned folders" onPress={open} />
      <View>
        {settings.status === "ready" ? (
          settings.values.nodes
            .filter((node) => node.parentId === null)
            .map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                nodes={settings.values.nodes}
                props={props}
                onError={setError}
              />
            ))
        ) : (
          <Text style={textStyle}>
            {settings.status === "loading" ? "Loading organization…" : "Organization unavailable"}
          </Text>
        )}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={textStyle}>
          {error}
        </Text>
      ) : null}
    </>
  );
}

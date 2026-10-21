import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WORKSPACE_TREE_INDENT, type WorkspaceTreeDrop } from "./tree";

export function WorkspaceTreeDropIndicator({ drop }: { drop: WorkspaceTreeDrop }) {
  const style = useMemo(
    () => [styles.indicator, styles[drop.position], { left: drop.depth * WORKSPACE_TREE_INDENT }],
    [drop.position, drop.depth],
  );
  return <View pointerEvents="none" style={style} />;
}

const styles = StyleSheet.create((theme) => ({
  indicator: { position: "absolute", right: 0, zIndex: 2, borderColor: theme.colors.accent },
  inside: {
    top: 0,
    bottom: 0,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.interactionHighlight,
  },
  before: { top: -1, borderTopWidth: 2 },
  after: { bottom: -1, borderBottomWidth: 2 },
}));

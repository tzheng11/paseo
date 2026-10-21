import { Text, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { Notification } from "@/components/message";
import type { NotificationItem } from "@/types/stream";

export function BoundedHistoryNotice(input: {
  item: NotificationItem;
  loading: boolean;
  error: string | null;
  onLoad: () => Promise<void>;
}) {
  const { item, loading, error, onLoad } = input;
  if (!item.historyGap) return <Notification level={item.level} message={item.message} />;
  const gap = item.historyGap;
  return (
    <PressHighlight
      style={historyNoticeStyle}
      highlightStyle={styles.highlightedNotice}
      accessibilityRole="button"
      disabled={loading}
      onPress={onLoad}
    >
      <Text style={styles.text}>
        {loading
          ? "Loading history…"
          : `Load earlier history (${gap.count.toLocaleString()} items · ${(gap.bytes / 1024 / 1024).toFixed(1)} MB)`}
      </Text>
      {error ? <Text style={styles.text}>{error}</Text> : null}
    </PressHighlight>
  );
}
function historyNoticeStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.container, (hovered || pressed) && styles.highlightedNotice];
}
const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  highlightedNotice: { backgroundColor: theme.colors.interactionHighlight },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

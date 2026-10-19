import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useMainHost } from "@/hosts/use-main-host";
import { settingsStyles } from "@/styles/settings";

export function MainHostBadge({ serverId }: { serverId: string }) {
  const { resolution } = useMainHost();
  if (resolution.mainHost !== serverId) return null;
  return <StatusBadge label="Main" variant="success" size="xs" />;
}

export function MakeMainHostButton({ serverId }: { serverId: string }) {
  const main = useMainHost();
  const router = useRouter();
  const host = main.views.find((view) => view.serverId === serverId);
  const open = useCallback(() => {
    router.push({
      pathname: "/settings/hosts/[serverId]/[hostSection]",
      params: { serverId, hostSection: "host", mainHost: "confirm" },
    });
  }, [router, serverId]);
  if (!host?.canManage || !host.supported) return null;
  if (main.resolution.mainHost === serverId) return null;
  const blocked =
    main.busy ||
    !host.connected ||
    !host.read ||
    main.resolution.kind === "loading" ||
    main.resolution.kind === "unavailable";
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={blocked}
      onPress={open}
      testID={`make-main-${serverId}`}
    >
      Make main host
    </Button>
  );
}

export function MainHostConfirmation({ serverId }: { serverId: string }) {
  const main = useMainHost();
  const router = useRouter();
  const [submitted, setSubmitted] = useState(false);
  const host = main.views.find((view) => view.serverId === serverId);
  const label = host?.label ?? serverId;
  const close = useCallback(() => router.setParams({ mainHost: undefined }), [router]);
  const confirm = useCallback(() => {
    setSubmitted(true);
    main.run({ kind: "set", serverId });
  }, [main, serverId]);
  const completed = submitted && !main.busy && main.resolution.mainHost === serverId;
  useEffect(() => {
    if (completed) close();
  }, [close, completed]);
  const checking = main.resolution.kind === "loading";
  const unavailable = main.resolution.kind === "unavailable";
  const canConfirm = host?.canManage && host.supported && host.connected && host.read;
  const blocked = main.busy || !canConfirm || checking || unavailable;
  return (
    <View style={styles.confirmation} testID="main-host-confirmation">
      <Text style={styles.breadcrumb}>Settings › Hosts › {label}</Text>
      <Text style={styles.confirmationTitle}>Make {label} your main host?</Text>
      <Text style={styles.description}>
        {main.resolution.kind === "unset"
          ? "This is the first choice. There is no Dots database to move."
          : "Choose this host for Paseo web and fleet-wide work."}
      </Text>
      <View style={[settingsStyles.card, styles.card]}>
        <Text style={styles.cardTitle}>One home for fleet-wide work</Text>
        <Text style={styles.cardDescription}>
          Paseo web will prefer {label} when there is no saved workspace. Your explicit host and
          project choices stay in place. Dots can be installed later.
        </Text>
      </View>
      <View style={[settingsStyles.card, styles.card]}>
        <Text style={styles.cardTitle}>Keep this host available</Text>
        <Text style={styles.cardDescription}>
          Use a host that stays on. You can change it here later; once Dots has a database, the
          change goes through Move main host.
        </Text>
      </View>
      <View style={styles.actions}>
        <Button variant="outline" disabled={main.busy} onPress={close}>
          Cancel
        </Button>
        <Button
          variant="default"
          disabled={blocked}
          loading={main.busy}
          testID="confirm-main-host"
          onPress={confirm}
        >
          Make main host
        </Button>
      </View>
      {checking || unavailable || main.error ? <MainHostStatus /> : null}
    </View>
  );
}

interface MainHostStatusCopy {
  title: string;
  description: string;
  provenance: string | null;
}

function formatSetTime(setAt: string): string {
  return new Date(setAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function describeMainHost(main: ReturnType<typeof useMainHost>): MainHostStatusCopy {
  const { resolution, views } = main;
  let title = "Main host";
  let description = "Main names the home for fleet-wide state. Next recommends available capacity.";
  let provenance: string | null = null;
  if (resolution.kind === "unset") {
    title = "No main host yet";
    description =
      "Choose an always-on host for Paseo web and fleet-wide work. Dots does not need to be installed.";
  } else if (resolution.kind === "loading") {
    title = "Checking Main host…";
    description = "Waiting for the connected hosts. Your current workspace stays open.";
  } else if (resolution.kind === "disagree") {
    title = "Hosts disagree about Main";
    description =
      "Choose the intended main host. Your saved workspace and host choices stay in place.";
  } else if (resolution.kind === "held") {
    title = "Main host change needs you";
    const setter = resolution.choice.setBy;
    const labelFor = (serverId: string | null) =>
      serverId ? (views.find((view) => view.serverId === serverId)?.label ?? serverId) : "unset";
    const time = formatSetTime(resolution.choice.setAt);
    description = `${setter.clientType} session ${setter.clientId} on ${labelFor(setter.serverId)} changed Main from ${labelFor(resolution.choice.previousMainHost)} to ${labelFor(resolution.choice.mainHost)} at ${time}. Deliver this change to the connected hosts, or undo it.`;
  } else if (resolution.kind === "unavailable") {
    title = "Main host settings unavailable";
    description =
      "Main choices stay unavailable until host settings load. Other Paseo chats keep working.";
  } else if (resolution.kind === "ready") {
    const host = views.find((view) => view.serverId === resolution.mainHost);
    const label = host?.label ?? resolution.mainHost;
    description = label
      ? `${label} is the main host. Paseo web prefers it when there is no saved workspace. Your explicit host and project choices stay in place.`
      : "No main host is selected. Your explicit host and project choices stay in place.";
    if (!label) title = "No main host yet";
    const sourceHost = views.find((view) => view.serverId === resolution.choice.setBy.serverId);
    const sourceLabel = sourceHost?.label ?? "another host";
    const time = formatSetTime(resolution.choice.setAt);
    provenance = `Set from ${resolution.choice.setBy.clientType} on ${sourceLabel} · ${time}. Every connected host agrees.`;
  }
  return { title, description, provenance };
}

export function MainHostStatus() {
  const main = useMainHost();
  const { resolution, views } = main;
  const { title, description, provenance } = describeMainHost(main);
  const held = resolution.kind === "held" ? resolution.choice : null;
  const connected = views.filter((view) => view.connected && view.supported);
  const canManage = connected.length > 0 && connected.every((view) => view.canManage);
  const deliver = useCallback(() => {
    if (held) main.run({ kind: "deliver", serverId: held.allocatorServerId, choice: held });
  }, [held, main]);
  const undo = useCallback(() => {
    if (held) main.run({ kind: "undo", serverId: held.allocatorServerId, choice: held });
  }, [held, main]);
  return (
    <View style={styles.status} testID="main-host-status">
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.description}>{description}</Text>
      {provenance ? (
        <Text style={styles.description} testID="main-host-provenance">
          {provenance}
        </Text>
      ) : null}
      {resolution.kind === "unset" ? (
        <View style={[settingsStyles.card, styles.card]}>
          <Text style={styles.cardTitle}>No Main badge is shown</Text>
          <Text style={styles.cardDescription}>
            Paseo keeps your saved workspace and host choices. Picking Main will not create or move
            a Dots database.
          </Text>
        </View>
      ) : null}
      {resolution.kind === "loading" ? (
        <>
          <View style={styles.skeleton} />
          <View style={[styles.skeleton, styles.shortSkeleton]} />
          <View style={styles.skeleton} />
          <View style={[settingsStyles.card, styles.card]}>
            <Text style={styles.cardTitle}>Still checking?</Text>
            <Text style={styles.cardDescription}>
              Main choices stay unavailable until host settings load. Other Paseo chats keep
              working.
            </Text>
          </View>
        </>
      ) : null}
      {resolution.kind === "disagree"
        ? views.map((view) => {
            const choice = view.read?.state.choice;
            const selectedHost = views.find((entry) => entry.serverId === choice?.mainHost);
            const selectedLabel = selectedHost?.label ?? choice?.mainHost ?? "Unset";
            const sourceHost = views.find((entry) => entry.serverId === choice?.setBy.serverId);
            const sourceLabel = sourceHost?.label ?? choice?.setBy.serverId;
            return (
              <Text
                key={view.serverId}
                style={settingsStyles.rowHint}
                testID={`main-choice-${view.serverId}`}
              >
                {view.label}:{" "}
                {choice
                  ? `${selectedLabel} · generation ${choice.generation} · ${choice.setBy.clientType} ${choice.setBy.clientId} on ${sourceLabel} · ${choice.setAt}`
                  : "No main host yet"}
              </Text>
            );
          })
        : null}
      {held && canManage ? (
        <View style={styles.actions}>
          <Button disabled={main.busy} onPress={deliver} testID="deliver-main-host">
            Deliver to connected hosts
          </Button>
          <Button disabled={main.busy} variant="ghost" onPress={undo} testID="undo-main-host">
            Undo
          </Button>
        </View>
      ) : null}
      {main.busy ? <Text style={settingsStyles.rowHint}>Saving Main host…</Text> : null}
      {main.error ? (
        <View>
          <Text style={settingsStyles.rowError} testID="main-host-error">
            {main.error.message}
          </Text>
          <Button variant="outline" onPress={main.retry}>
            Retry this change
          </Button>
        </View>
      ) : null}
      {views
        .filter((view) => view.connected && view.error)
        .map((view) => (
          <Text key={view.serverId} style={settingsStyles.rowError} testID="main-host-read-error">
            {view.label}: {view.error?.message}
          </Text>
        ))}
      {resolution.kind === "loading" || resolution.kind === "unavailable" ? (
        <Button variant="outline" onPress={main.refresh}>
          Retry host settings
        </Button>
      ) : null}
      {views
        .filter((view) => view.connected && !view.supported)
        .map((view) => (
          <Text key={view.serverId} style={settingsStyles.rowHint}>
            Update {view.label} to use Main host. The previous setting is unchanged.
          </Text>
        ))}
    </View>
  );
}

export function MainHostSection({ serverId }: { serverId: string }) {
  return (
    <View style={styles.section} testID="main-host-section">
      <MainHostStatus />
      <View style={styles.actions}>
        <MainHostBadge serverId={serverId} />
        <MakeMainHostButton serverId={serverId} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { marginVertical: theme.spacing[6], minWidth: 0, maxWidth: "100%" },
  status: {
    width: "100%",
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "100%",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[4],
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[3] },
  confirmation: { minWidth: 0, width: "100%", gap: theme.spacing[6] },
  confirmationTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["4xl"],
    fontWeight: theme.fontWeight.medium,
  },
  breadcrumb: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.6,
    flexShrink: 1,
  },
  card: {
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  cardDescription: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.6,
  },
  skeleton: {
    height: theme.spacing[16],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  shortSkeleton: { width: "85%" },
}));

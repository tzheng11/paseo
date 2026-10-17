import type { HostStats } from "@getpaseo/protocol/messages";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HostStatusDot } from "@/components/host-status-dot";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import {
  formatGigabytes,
  type HostLoadWarning,
  type HostOverviewRow,
  type HostOverviewState,
} from "./model";
import { useHostsOverview } from "./use-hosts-overview";

type Translate = ReturnType<typeof useTranslation>["t"];

/** One row per saved host: its work, its load, and which host takes the next agent. */
export function HostsOverview() {
  const { t } = useTranslation();
  const rows = useHostsOverview();
  const isCompact = useIsCompactFormFactor();

  if (rows.length === 0) return null;

  return (
    <View style={styles.container} testID="hosts-overview">
      <View style={settingsStyles.sectionHeader}>
        <View style={styles.titleLine}>
          <Text style={settingsStyles.sectionHeaderTitle}>{t("openProject.hosts.title")}</Text>
          <SettingsInfoTip
            title={t("openProject.hosts.title")}
            info={t("openProject.hosts.info")}
            testID="hosts-overview-info"
          />
        </View>
      </View>
      <View style={settingsStyles.card}>
        {isCompact ? null : <ColumnHeaders t={t} />}
        {rows.map((row, index) => (
          <HostRow key={row.serverId} row={row} isCompact={isCompact} isFirst={index === 0} />
        ))}
      </View>
    </View>
  );
}

function ColumnHeaders({ t }: { t: Translate }) {
  return (
    <View style={[settingsStyles.row, styles.headerRow]}>
      <Text style={[styles.headerText, styles.hostColumn]}>
        {t("openProject.hosts.columns.host")}
      </Text>
      <Text style={[styles.headerText, styles.countColumn]}>
        {t("openProject.hosts.columns.workspaces")}
      </Text>
      <Text style={[styles.headerText, styles.countColumn]}>
        {t("openProject.hosts.columns.agents")}
      </Text>
      <Text style={[styles.headerText, styles.cpuColumn]}>
        {t("openProject.hosts.columns.cpu")}
      </Text>
      <Text style={[styles.headerText, styles.memoryColumn]}>
        {t("openProject.hosts.columns.memory")}
      </Text>
    </View>
  );
}

function HostRow({
  row,
  isCompact,
  isFirst,
}: {
  row: HostOverviewRow;
  isCompact: boolean;
  isFirst: boolean;
}) {
  const { t } = useTranslation();
  const { state } = row;
  const stats = state.kind === "ready" ? state.stats : null;
  const status = statusText(state, t);
  const warnings = state.kind === "ready" ? warningText(state.warnings, t) : null;

  return (
    <View
      style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder]}
      testID={`hosts-overview-row-${row.serverId}`}
    >
      <View style={styles.hostColumn}>
        <View style={styles.hostLine}>
          <HostStatusDot serverId={row.serverId} />
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {row.label}
          </Text>
          {row.isNext ? (
            <StatusBadge label={t("openProject.hosts.next")} variant="success" size="xs" />
          ) : null}
        </View>
        {status ? (
          <Text style={state.kind === "failed" ? settingsStyles.rowError : settingsStyles.rowHint}>
            {status}
          </Text>
        ) : null}
        {stats && isCompact ? (
          <Text style={settingsStyles.rowHint}>{compactSummary(stats, t)}</Text>
        ) : null}
        {warnings ? <Text style={styles.warningText}>{warnings}</Text> : null}
      </View>
      {stats && !isCompact ? <StatsColumns stats={stats} t={t} /> : null}
    </View>
  );
}

function StatsColumns({ stats, t }: { stats: HostStats; t: Translate }) {
  const swap = stats.memory.swapUsedBytes ?? 0;
  const pressure = pressureText(stats.memory.pressure, t);
  return (
    <>
      <Text style={[styles.valueText, styles.countColumn]}>
        {`${stats.workspaces.running} / ${stats.workspaces.total}`}
      </Text>
      <Text style={[styles.valueText, styles.countColumn]}>
        {`${stats.agents.running} / ${stats.agents.total}`}
      </Text>
      <View style={styles.cpuColumn}>
        <Text style={styles.valueText}>{`${Math.round(stats.cpu.idlePercent)}%`}</Text>
        <Text style={styles.subText}>
          {t("openProject.hosts.cores", { count: stats.cpu.cores })}
        </Text>
      </View>
      <View style={styles.memoryColumn}>
        <Text style={styles.valueText}>
          {t("openProject.hosts.memoryUsed", {
            used: formatGigabytes(stats.memory.usedBytes),
            total: formatGigabytes(stats.memory.totalBytes),
          })}
        </Text>
        {swap > 0 ? (
          <Text style={styles.subText}>
            {t("openProject.hosts.swap", { size: formatGigabytes(swap) })}
          </Text>
        ) : null}
        {pressure ? (
          <Text
            style={stats.memory.pressure === "critical" ? styles.dangerText : styles.warningText}
          >
            {pressure}
          </Text>
        ) : null}
      </View>
    </>
  );
}

function statusText(state: HostOverviewState, t: Translate): string | null {
  switch (state.kind) {
    case "connecting":
      return t("openProject.hosts.status.connecting");
    case "offline":
      return t("openProject.hosts.status.offline");
    case "unsupported":
      return t("openProject.hosts.status.unsupported");
    case "loading":
      return t("openProject.hosts.status.loading");
    case "failed":
      return state.message;
    case "ready":
      return null;
  }
}

function warningText(warnings: HostLoadWarning[], t: Translate): string | null {
  if (warnings.length === 0) return null;
  return warnings
    .map((warning) => {
      switch (warning.kind) {
        case "swap":
          return t("openProject.hosts.warnings.swap", { size: formatGigabytes(warning.bytes) });
        case "busy":
          return t("openProject.hosts.warnings.busy", {
            percent: Math.round(warning.idlePercent),
          });
        case "gitQueue":
          return t("openProject.hosts.warnings.gitQueue", { count: warning.pending });
      }
    })
    .join(" · ");
}

function pressureText(pressure: string | null, t: Translate): string | null {
  if (pressure === "warn") return t("openProject.hosts.pressure.warn");
  if (pressure === "critical") return t("openProject.hosts.pressure.critical");
  return null;
}

function compactSummary(stats: HostStats, t: Translate): string {
  return [
    t("openProject.hosts.compact.workspaces", {
      active: stats.workspaces.running,
      total: stats.workspaces.total,
    }),
    t("openProject.hosts.compact.agents", {
      active: stats.agents.running,
      total: stats.agents.total,
    }),
    t("openProject.hosts.compact.cpu", { percent: Math.round(stats.cpu.idlePercent) }),
    t("openProject.hosts.memoryUsed", {
      used: formatGigabytes(stats.memory.usedBytes),
      total: formatGigabytes(stats.memory.totalBytes),
    }),
  ].join(" · ");
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    maxWidth: { xs: 452, md: 600 },
    marginTop: { xs: theme.spacing[6], md: theme.spacing[8] },
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  headerRow: {
    paddingVertical: theme.spacing[2],
  },
  headerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hostColumn: {
    flex: 1,
    minWidth: 0,
    marginRight: theme.spacing[3],
  },
  hostLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  countColumn: {
    width: 88,
    flexShrink: 0,
    textAlign: "right",
  },
  cpuColumn: {
    width: 88,
    flexShrink: 0,
    alignItems: "flex-end",
    textAlign: "right",
  },
  memoryColumn: {
    width: 112,
    flexShrink: 0,
    alignItems: "flex-end",
    textAlign: "right",
  },
  valueText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
  },
  subText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  warningText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  dangerText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
}));

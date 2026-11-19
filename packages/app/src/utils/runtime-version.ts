import type { RuntimeBuildIdentity } from "@getpaseo/protocol/runtime-build";

export function formatRuntimeVersionBadge(
  version: string | null,
  build?: RuntimeBuildIdentity,
): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  const label = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  if (!build) return label;
  return `${label} · ${build.sourceCommit.slice(0, 8)}/${build.buildId.slice(0, 8)}${build.sourceDirty ? " (modified)" : ""}`;
}

import type { HostProfile } from "@/types/host-connection";

export function formatRoutedHostLabel(
  originServerId: string,
  hosts: readonly Pick<HostProfile, "serverId" | "label">[],
): string {
  const origin = hosts.find((host) => host.serverId === originServerId);
  const label = origin?.label.trim();
  if (!label || label === originServerId) return "Via another host";
  return `Via ${label}`;
}

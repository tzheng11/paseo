import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { HostProfile } from "@/types/host-connection";
import { openWorkspaceParentSelection, type WorkspaceParentEntry } from "./parent-selection";

export const ROOT_WORKSPACE_PARENT_OPTION = "root";

export function useWorkspaceParentPicker(input: {
  parentWorkspaceKey?: string;
  workspaces: readonly WorkspaceParentEntry[];
  hosts: readonly HostProfile[];
  noParentLabel: string;
  unavailableLabel: string;
}) {
  const [model] = useState(() => openWorkspaceParentSelection(input.parentWorkspaceKey));
  const selection = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => model.applyCatalog(input.workspaces), [input.workspaces, model]);
  useEffect(() => () => model.close(), [model]);

  const entriesByKey = useMemo(
    () =>
      new Map(
        input.workspaces
          .filter((entry) => !entry.background && !entry.archivingAt)
          .map((entry) => [entry.workspaceKey, entry]),
      ),
    [input.workspaces],
  );
  const options = useMemo<ComboboxOption[]>(() => {
    const hostNames = new Map(input.hosts.map((host) => [host.serverId, host.label]));
    return [
      { id: ROOT_WORKSPACE_PARENT_OPTION, label: input.noParentLabel },
      ...[...entriesByKey.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({
          id: entry.workspaceKey,
          label: entry.name,
          description: `${entry.projectName} · ${hostNames.get(entry.serverId) ?? entry.serverId}`,
        })),
    ];
  }, [entriesByKey, input.hosts, input.noParentLabel]);
  return {
    selection,
    selectedOptionId: selection.workspaceKey ?? ROOT_WORKSPACE_PARENT_OPTION,
    triggerLabel:
      selection.display ?? (selection.workspaceKey ? input.unavailableLabel : input.noParentLabel),
    options,
    select(id: string) {
      if (id === ROOT_WORKSPACE_PARENT_OPTION) model.select(null);
      else {
        const entry = entriesByKey.get(id);
        if (entry) model.select(entry);
      }
    },
  };
}

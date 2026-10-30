export function mergeWithRemainder(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): string[] {
  const reorderedSet = new Set(input.reorderedVisibleKeys);
  const remainder = input.currentOrder.filter((key) => !reorderedSet.has(key));
  return [...input.reorderedVisibleKeys, ...remainder];
}

export function hasVisibleOrderChanged(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): boolean {
  const visibleSet = new Set(input.reorderedVisibleKeys);
  const currentVisible = input.currentOrder.filter((key) => visibleSet.has(key));
  if (currentVisible.length !== input.reorderedVisibleKeys.length) {
    return true;
  }
  return input.reorderedVisibleKeys.some((key, index) => currentVisible[index] !== key);
}

/** Preserve other visible projects when a successful drag changes the global sort. */
export function captureUnmovedProjectOrders(input: {
  projects: readonly {
    viewKey: string;
    workspaces: readonly { workspaceKey: string }[];
  }[];
  movedProjectViewKey: string;
  workspaceOrderByProject: Readonly<Record<string, string[]>>;
  workspaceSortModeByProject: Readonly<Record<string, string | undefined>>;
}): Array<{ projectViewKey: string; order: string[] }> {
  const captured: Array<{ projectViewKey: string; order: string[] }> = [];
  for (const project of input.projects) {
    if (
      project.viewKey === input.movedProjectViewKey ||
      (input.workspaceSortModeByProject[project.viewKey] ?? "manual") !== "manual" ||
      (input.workspaceOrderByProject[project.viewKey]?.length ?? 0) > 0 ||
      project.workspaces.length === 0
    )
      continue;
    // An existing manual order is history, even if all its keys are currently
    // hidden. Capture only a project which has no saved order to restore.
    captured.push({
      projectViewKey: project.viewKey,
      order: project.workspaces.map((workspace) => workspace.workspaceKey),
    });
  }
  return captured;
}

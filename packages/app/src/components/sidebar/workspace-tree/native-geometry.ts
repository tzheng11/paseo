export interface WorkspaceRowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MeasurableWorkspaceRow {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}

export function measureWorkspaceTreeRows<T extends MeasurableWorkspaceRow>(
  nodes: ReadonlyMap<string, T>,
  isCurrent: () => boolean,
  onMeasured: (rects: Map<string, WorkspaceRowGeometry>) => void,
): void {
  const entries = [...nodes];
  const rects = new Map<string, WorkspaceRowGeometry>();
  let remaining = entries.length;
  const finish = () => {
    if (!isCurrent()) return;
    // A row may disappear or remount while native measurement callbacks are in flight.
    for (const [key, node] of entries) if (nodes.get(key) !== node) rects.delete(key);
    onMeasured(rects);
  };
  if (remaining === 0) return finish();
  for (const [key, node] of entries) {
    node.measureInWindow((x, y, width, height) => {
      if (!isCurrent()) return;
      rects.set(key, { x, y, width, height });
      remaining -= 1;
      if (remaining === 0) finish();
    });
  }
}

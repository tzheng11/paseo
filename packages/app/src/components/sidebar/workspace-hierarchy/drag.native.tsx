import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import {
  PanResponder,
  View,
  type LayoutChangeEvent,
  type GestureResponderEvent,
} from "react-native";
import {
  projectWorkspaceTreeDrop,
  visibleWorkspaceTreeRows,
  workspaceTreeDropPosition,
  type WorkspaceTreeDrop,
  type WorkspaceTreeRow,
} from "./tree";
import type { WorkspaceTreeDragProps } from "./drag.types";
import { WorkspaceTreeDropIndicator } from "./drop-indicator";

interface RowLayout {
  key: string;
  y: number;
  height: number;
}
interface NativeDrag {
  activeKey: string;
  drop: WorkspaceTreeDrop | null;
  offsetX: number;
  offsetY: number;
}

function NativeWorkspaceTreeRow({
  row,
  drag,
  arm,
  measure,
  renderRow,
}: {
  row: WorkspaceTreeRow;
  drag: NativeDrag | null;
  arm: (row: WorkspaceTreeRow) => void;
  measure: (key: string, event: LayoutChangeEvent) => void;
  renderRow: WorkspaceTreeDragProps["renderRow"];
}) {
  const key = row.workspace.workspaceKey;
  const active = drag?.activeKey === key;
  const target = drag?.drop?.targetKey === key ? drag.drop : null;
  const offsetX = active ? drag.offsetX : 0;
  const offsetY = active ? drag.offsetY : 0;
  const style = useMemo(
    () =>
      active
        ? {
            zIndex: 100,
            opacity: 0.6,
            transform: [{ translateX: offsetX }, { translateY: offsetY }],
          }
        : undefined,
    [active, offsetX, offsetY],
  );
  const onLayout = useCallback((event: LayoutChangeEvent) => measure(key, event), [measure, key]);
  const start = useCallback(() => arm(row), [arm, row]);
  return (
    <View onLayout={onLayout} testID={`sidebar-workspace-tree-row-${key}`} style={style}>
      {target ? <WorkspaceTreeDropIndicator drop={target} /> : null}
      {renderRow({ row, drag: start, isDragging: active })}
    </View>
  );
}

/** The row's existing hold gesture arms this responder; ordinary touches keep native scrolling. */
export function WorkspaceTreeDrag({
  rows,
  displayRows,
  collapsedKeys,
  disabled,
  canDrag,
  onMove,
  renderRow,
  testID,
}: WorkspaceTreeDragProps): ReactElement {
  const container = useRef<View>(null);
  const layouts = useRef(new Map<string, RowLayout>());
  const origin = useRef({ x: 0, y: 0 });
  const dragRef = useRef<NativeDrag | null>(null);
  const [drag, setDrag] = useState<NativeDrag | null>(null);
  const visible = visibleWorkspaceTreeRows({
    rows: displayRows,
    collapsedKeys,
    draggingKey: drag?.activeKey,
  });
  const latest = useRef({ rows, onMove, visible });
  latest.current = { rows, onMove, visible };
  const update = useCallback((event: GestureResponderEvent, offsetX: number, offsetY: number) => {
    const active = dragRef.current;
    if (!active) return;
    const y = event.nativeEvent.pageY - origin.current.y;
    let target = latest.current.visible.find((row) => {
      const layout = layouts.current.get(row.workspace.workspaceKey);
      return layout && y >= layout.y && y <= layout.y + layout.height;
    });
    if (!target) {
      const first = latest.current.visible[0];
      const firstLayout = first ? layouts.current.get(first.workspace.workspaceKey) : null;
      target = firstLayout && y < firstLayout.y ? first : latest.current.visible.at(-1);
    }
    const layout = target ? layouts.current.get(target.workspace.workspaceKey) : null;
    const drop =
      target && layout
        ? projectWorkspaceTreeDrop({
            rows: latest.current.rows,
            activeKey: active.activeKey,
            targetKey: target.workspace.workspaceKey,
            position: workspaceTreeDropPosition((y - layout.y) / layout.height),
            horizontalOffset: offsetX,
          })
        : null;
    const next = { activeKey: active.activeKey, drop, offsetX, offsetY };
    dragRef.current = next;
    setDrag(next);
  }, []);
  const clear = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: () => dragRef.current !== null,
        onPanResponderMove: (event, gesture) => update(event, gesture.dx, gesture.dy),
        onPanResponderRelease: () => {
          const drop = dragRef.current?.drop;
          clear();
          if (drop) latest.current.onMove(drop.move);
        },
        onPanResponderTerminate: clear,
        onPanResponderTerminationRequest: () => dragRef.current === null,
      }),
    [clear, update],
  );
  const arm = useCallback(
    (row: WorkspaceTreeRow) => {
      if (disabled || !canDrag(row)) return;
      container.current?.measureInWindow((x, y) => {
        origin.current = { x, y };
      });
      const next = { activeKey: row.workspace.workspaceKey, drop: null, offsetX: 0, offsetY: 0 };
      dragRef.current = next;
      setDrag(next);
    },
    [disabled, canDrag],
  );
  const measure = useCallback((key: string, event: LayoutChangeEvent) => {
    layouts.current.set(key, {
      key,
      y: event.nativeEvent.layout.y,
      height: event.nativeEvent.layout.height,
    });
  }, []);
  const releaseUnmoved = useCallback(() => {
    const active = dragRef.current;
    if (active?.offsetX === 0 && active.offsetY === 0) clear();
  }, [clear]);
  return (
    <View ref={container} testID={testID} {...responder.panHandlers} onTouchEnd={releaseUnmoved}>
      {visible.map((row) => (
        <NativeWorkspaceTreeRow
          key={row.workspace.workspaceKey}
          row={row}
          drag={drag}
          arm={arm}
          measure={measure}
          renderRow={renderRow}
        />
      ))}
    </View>
  );
}

import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragMoveEvent,
  type DragEndEvent,
  type DragStartEvent,
  type DndContextProps,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  projectWorkspaceTreeDrop,
  visibleWorkspaceTreeRows,
  workspaceTreeDropPosition,
  WORKSPACE_TREE_INDENT,
  type WorkspaceTreeDrop,
  type WorkspaceTreeRow,
} from "./tree";
import type { WorkspaceTreeDragProps, WorkspaceTreeDragState } from "./drag.types";
import { WorkspaceTreeDropIndicator } from "./drop-indicator";
import { workspaceTreeKeyboardDrop } from "./keyboard";

const TREE_ACCESSIBILITY: DndContextProps["accessibility"] = {
  screenReaderInstructions: {
    draggable:
      "Press Space to move a workspace. Up and Down reorder, Right nests under a workspace, and Left moves out of its parent. Press Space to save, or Escape to cancel.",
  },
};

function DragRow({
  row,
  activeKey,
  drop,
  disabled,
  renderRow,
}: {
  row: WorkspaceTreeRow;
  activeKey: string | null;
  drop: WorkspaceTreeDrop | null;
  disabled: boolean;
  renderRow: WorkspaceTreeDragProps["renderRow"];
}) {
  const key = row.workspace.workspaceKey;
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform } = useSortable({
    id: key,
    disabled: { draggable: disabled },
  });
  const setNode = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setNodeRef, setActivatorNodeRef],
  );
  const isDragging = activeKey === key;
  const target = drop?.targetKey === key ? drop : null;
  const style = useMemo(
    () => ({
      position: "relative" as const,
      zIndex: isDragging ? 1000 : undefined,
      transform: isDragging ? CSS.Translate.toString(transform) : undefined,
      opacity: isDragging ? 0.55 : 1,
    }),
    [isDragging, transform],
  );
  return (
    <div
      ref={setNode}
      {...attributes}
      {...listeners}
      aria-label={`Move ${row.workspace.name}`}
      data-testid={`sidebar-workspace-tree-row-${key}`}
      data-depth={row.depth}
      data-parent-workspace-id={row.workspace.parentWorkspaceId ?? ""}
      data-drop-position={target?.position ?? ""}
      style={style}
    >
      {target ? <WorkspaceTreeDropIndicator drop={target} /> : null}
      {renderRow({ row, isDragging, drag: noop })}
    </div>
  );
}
function noop() {}

function projectEvent(
  rows: WorkspaceTreeRow[],
  event: DragMoveEvent,
  keyboardDrop: WorkspaceTreeDrop | null,
): WorkspaceTreeDrop | null {
  if (event.activatorEvent instanceof KeyboardEvent) return keyboardDrop;
  if (!event.over) return null;
  const { activatorEvent } = event;
  let startY: number | null = null;
  if (activatorEvent instanceof MouseEvent) startY = activatorEvent.clientY;
  if (activatorEvent instanceof TouchEvent) startY = activatorEvent.touches[0]?.clientY ?? null;
  const translated = event.active.rect.current.translated;
  const pointerY =
    startY === null
      ? (translated?.top ?? 0) + (translated?.height ?? 0) / 2
      : startY + event.delta.y;
  const relativeY = (pointerY - event.over.rect.top) / event.over.rect.height;
  return projectWorkspaceTreeDrop({
    rows,
    activeKey: String(event.active.id),
    targetKey: String(event.over.id),
    position: workspaceTreeDropPosition(relativeY),
    horizontalOffset: event.delta.x,
  });
}

export function WorkspaceTreeDrag({
  rows,
  collapsedKeys,
  disabled,
  canDrag,
  onMove,
  renderRow,
  testID,
}: WorkspaceTreeDragProps): ReactElement {
  const [drag, setDrag] = useState<WorkspaceTreeDragState | null>(null);
  const keyboardDrop = useRef<WorkspaceTreeDrop | null>(null);
  const activeKey = drag?.activeKey;
  const visible = useMemo(
    () => visibleWorkspaceTreeRows({ rows, collapsedKeys, draggingKey: activeKey }),
    [rows, collapsedKeys, activeKey],
  );
  const ids = useMemo(() => visible.map((row) => row.workspace.workspaceKey), [visible]);
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>(
    (event, args) => {
      const active = String(args.active);
      const overKey =
        keyboardDrop.current?.targetKey ??
        (args.context.over ? String(args.context.over.id) : null);
      const drop = workspaceTreeKeyboardDrop({
        rows,
        visibleRows: visible,
        activeKey: active,
        overKey,
        code: event.code,
      });
      if (!drop) return;
      const rect = args.context.droppableRects.get(drop.targetKey);
      const activeRect = args.context.draggingNodeRect;
      const source = rows.find((row) => row.workspace.workspaceKey === active);
      if (!rect || !activeRect || !source) return;
      event.preventDefault();
      keyboardDrop.current = drop;
      const fraction = { before: 0.125, inside: 0.5, after: 0.875 }[drop.position];
      return {
        x: activeRect.left + (drop.depth - source.depth) * WORKSPACE_TREE_INDENT,
        y: rect.top + rect.height * fraction - activeRect.height / 2,
      };
    },
    [rows, visible],
  );
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );
  const start = useCallback((event: DragStartEvent) => {
    keyboardDrop.current = null;
    setDrag({ activeKey: String(event.active.id), drop: null });
  }, []);
  const cancel = useCallback(() => setDrag(null), []);
  const updateDrop = useCallback(
    (event: DragMoveEvent) => {
      setDrag({
        activeKey: String(event.active.id),
        drop: projectEvent(rows, event, keyboardDrop.current),
      });
    },
    [rows],
  );
  const finish = useCallback(
    (event: DragEndEvent) => {
      const drop = projectEvent(rows, event, keyboardDrop.current);
      setDrag(null);
      if (drop) onMove(drop.move);
    },
    [rows, onMove],
  );
  return (
    <View testID={testID}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={start}
        onDragMove={updateDrop}
        onDragOver={updateDrop}
        onDragCancel={cancel}
        onDragEnd={finish}
        accessibility={TREE_ACCESSIBILITY}
      >
        <SortableContext items={ids}>
          {visible.map((row) => (
            <DragRow
              key={row.workspace.workspaceKey}
              row={row}
              activeKey={drag?.activeKey ?? null}
              drop={drag?.drop ?? null}
              disabled={disabled || !canDrag(row)}
              renderRow={renderRow}
            />
          ))}
        </SortableContext>
      </DndContext>
    </View>
  );
}

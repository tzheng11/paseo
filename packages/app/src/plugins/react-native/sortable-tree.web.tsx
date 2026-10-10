import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type {
  SortableTreeItem,
  SortableTreeMove,
  SortableTreeProps,
} from "@getpaseo/plugin/client/ui";
import { treeDropMove, visibleTreeItems } from "./sortable-tree-model";

interface Target {
  id: string | null;
  position: "before" | "inside" | "after" | "root";
}
const rootTarget: Target = { id: null, position: "root" };
// A pointer outside valid destinations must cancel, rather than snap to a nearby valid one.
const collision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

function DropZone({
  target,
  valid,
  active,
  children,
  colors,
  testID,
}: {
  target: Target;
  valid: boolean;
  active: boolean;
  children?: ReactNode;
  colors: SortableTreeProps["colors"];
  testID: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: testID, data: target, disabled: !valid });
  const root = target.position === "root";
  const style = useMemo<CSSProperties>(
    () => ({
      minHeight: root ? 28 : 6,
      marginLeft: root ? 0 : 8,
      borderRadius: 4,
      color: colors.muted,
      fontSize: 12,
      padding: root ? "6px 10px" : 0,
      background: valid && isOver ? colors.accent : undefined,
      outline: root && active ? `1px dashed ${colors.border}` : undefined,
      display: root && !active ? "none" : undefined,
    }),
    [root, colors, valid, isOver, active],
  );
  return (
    <div ref={setNodeRef} data-testid={testID} style={style}>
      {children}
    </div>
  );
}

function TreeRow({
  item,
  depth,
  props,
  activeId,
  move,
}: {
  item: SortableTreeItem;
  depth: number;
  props: SortableTreeProps;
  activeId: string | null;
  move(target: Target): SortableTreeMove | null;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: item.id,
    disabled: props.disabled,
  });
  const target = useMemo<Target>(
    () => ({ id: item.id, position: item.acceptsChildren ? "inside" : "after" }),
    [item.id, item.acceptsChildren],
  );
  const before = useMemo<Target>(() => ({ id: item.id, position: "before" }), [item.id]);
  const after = useMemo<Target>(() => ({ id: item.id, position: "after" }), [item.id]);
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `row-${item.id}`,
    data: target,
    disabled: !activeId || !move(target),
  });
  const handleStyle = useMemo<CSSProperties>(
    () => ({
      border: 0,
      background: "transparent",
      color: props.colors.muted,
      cursor: props.disabled ? "default" : "grab",
      touchAction: "none",
      padding: "8px 6px",
      borderRadius: 4,
    }),
    [props.colors.muted, props.disabled],
  );
  const rowStyle = useMemo(() => ({ opacity: isDragging ? 0.35 : 1 }), [isDragging]);
  const targetStyle = useMemo(
    () => ({ outline: isOver ? `1px solid ${props.colors.accent}` : undefined, borderRadius: 4 }),
    [isOver, props.colors.accent],
  );
  const indentStyle = useMemo(() => ({ marginLeft: depth * 12 }), [depth]);
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`Drag ${item.label}`}
      disabled={props.disabled}
      data-testid={`${props.testID}-handle-${item.id}`}
      style={handleStyle}
    >
      ⠿
    </button>
  );
  return (
    <div style={indentStyle}>
      <DropZone
        target={before}
        valid={!!move(before)}
        active={!!activeId}
        colors={props.colors}
        testID={`${props.testID}-before-${item.id}`}
      />
      <div ref={setNodeRef} style={rowStyle}>
        <div ref={setDropRef} data-testid={`${props.testID}-target-${item.id}`} style={targetStyle}>
          {props.renderItem({ id: item.id, depth, dragHandle: handle })}
        </div>
      </div>
      <DropZone
        target={after}
        valid={!!move(after)}
        active={!!activeId}
        colors={props.colors}
        testID={`${props.testID}-after-${item.id}`}
      />
    </div>
  );
}

export function SortableTree(props: SortableTreeProps) {
  const { onMove } = props;
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const move = useCallback(
    (target: Target) =>
      activeId ? treeDropMove(props.items, activeId, target.id, target.position) : null,
    [props.items, activeId],
  );
  const rows = visibleTreeItems(props.items);
  const active = props.items.find((item) => item.id === activeId);
  const accessibility = useMemo(
    () => ({
      announcements: {
        onDragStart: () =>
          `Dragging ${active?.label ?? "entry"}. Drop on a folder to move inside, or between rows to reorder. Press Escape to cancel.`,
        onDragOver: ({ over }: { over: unknown }) =>
          over ? "Move to the highlighted location" : "No valid destination",
        onDragEnd: () => "Drag finished",
        onDragCancel: () => "Drag canceled",
      },
    }),
    [active?.label],
  );
  const start = useCallback((event: DragStartEvent) => setActiveId(String(event.active.id)), []);
  const cancel = useCallback(() => setActiveId(null), []);
  const end = useCallback(
    ({ over }: DragEndEvent) => {
      const target = over?.data.current as Target | undefined;
      const result = target ? move(target) : null;
      setActiveId(null);
      if (result) onMove(result);
    },
    [move, onMove],
  );
  const overlayStyle = useMemo(
    () => ({
      padding: 10,
      border: `1px solid ${props.colors.accent}`,
      borderRadius: 6,
      background: props.colors.background,
      color: props.colors.foreground,
    }),
    [props.colors],
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      accessibility={accessibility}
      onDragStart={start}
      onDragCancel={cancel}
      onDragEnd={end}
    >
      <div data-testid={props.testID}>
        {rows.map(({ item, depth }) => (
          <TreeRow
            key={item.id}
            item={item}
            depth={depth}
            props={props}
            activeId={activeId}
            move={move}
          />
        ))}
        <DropZone
          target={rootTarget}
          valid={!!move(rootTarget)}
          active={!!activeId}
          colors={props.colors}
          testID={`${props.testID}-root`}
        >
          Move to top level
        </DropZone>
      </div>
      <DragOverlay>{active ? <div style={overlayStyle}>{active.label}</div> : null}</DragOverlay>
    </DndContext>
  );
}

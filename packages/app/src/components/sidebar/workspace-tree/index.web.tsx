import { isWeb } from "@/constants/platform";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Text, View, ScrollView } from "react-native";
import { GripVertical } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
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
  type DragMoveEvent,
  type DragStartEvent,
  type DragEndEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  DraggableListProps,
  DraggableListDragHandleProps,
} from "@/components/draggable-list.types";
import { getEventCoordinates } from "@dnd-kit/utilities";
import {
  WorkspaceTreeController,
  useWorkspaceTreeDrag,
  type WorkspaceTreeProviderProps,
} from "./controller";
import { workspaceDropPosition } from "./drop-target";
import {
  WorkspaceTreeRowChrome,
  foregroundMutedColorMapping,
  workspaceTreeStyles,
  type WorkspaceTreeRowProps,
} from "./row-chrome";
const ThemedGrip = withUnistyles(GripVertical);
const treeCollisionDetection: CollisionDetection = (args) => {
  const kind = args.active.data.current?.kind;
  const scoped = {
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => container.data.current?.kind === kind,
    ),
  };
  return args.pointerCoordinates ? pointerWithin(scoped) : closestCenter(scoped);
};

export function WorkspaceTreeProvider(props: WorkspaceTreeProviderProps) {
  return (
    <WorkspaceTreeController {...props}>
      <WebTreeDragSurface>{props.children}</WebTreeDragSurface>
    </WorkspaceTreeController>
  );
}
function WebTreeDragSurface({ children }: { children: React.ReactNode }) {
  const drag = useWorkspaceTreeDrag();
  const origin = useRef<{ x: number; y: number } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!isWeb) return;
    const trackPointer = (event: MouseEvent | TouchEvent) => {
      pointer.current = getEventCoordinates(event);
    };
    document.addEventListener("mousemove", trackPointer, true);
    document.addEventListener("touchmove", trackPointer, true);
    return () => {
      document.removeEventListener("mousemove", trackPointer, true);
      document.removeEventListener("touchmove", trackPointer, true);
    };
  }, []);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const updateTarget = useCallback(
    (event: DragMoveEvent) => {
      if (event.active.data.current?.kind === "project") return;
      if (!event.over) return drag.hover("", "inside");
      const targetNode: HTMLDivElement | undefined = event.over.data.current?.elementRef?.current;
      // dnd-kit caches row geometry across scroll frames. Use the viewport's
      // current bounds for the before/inside/after zones while auto-scrolling.
      const rect = (isWeb ? targetNode?.getBoundingClientRect() : undefined) ?? event.over.rect;
      const point = origin.current;
      const y =
        pointer.current?.y ?? (point ? point.y + event.delta.y : rect.top + rect.height / 2);
      drag.hover(String(event.over.id), workspaceDropPosition(y - rect.top, rect.height));
    },
    [drag],
  );
  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      if (event.active.data.current?.kind === "project") return;
      origin.current = getEventCoordinates(event.activatorEvent);
      pointer.current = origin.current;
      drag.start(String(event.active.id));
    },
    [drag],
  );
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (event.active.data.current?.kind === "project") {
        if (event.over)
          event.active.data.current.onProjectDrop?.(String(event.active.id), String(event.over.id));
        return;
      }
      updateTarget(event);
      drag.finish();
    },
    [drag, updateTarget],
  );
  const active = drag.workspaces.find(
    (workspace) => workspace.workspaceKey === drag.activeWorkspaceKey,
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={treeCollisionDetection}
      onDragStart={onDragStart}
      onDragMove={updateTarget}
      onDragOver={updateTarget}
      onDragEnd={onDragEnd}
      onDragCancel={drag.cancel}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {active ? (
          <View style={workspaceTreeStyles.ghost}>
            <Text style={workspaceTreeStyles.ghostText}>{active.name}</Text>
          </View>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
export function WorkspaceTreeRow(props: WorkspaceTreeRowProps) {
  const controller = useWorkspaceTreeDrag();
  const disabled = !controller.enabled(props.workspace);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const dragData = useMemo(() => ({ kind: "workspace", elementRef }), []);
  const draggable = useDraggable({
    id: props.workspace.workspaceKey,
    disabled,
    data: dragData,
  });
  const droppable = useDroppable({
    id: props.workspace.workspaceKey,
    disabled,
    data: dragData,
  });
  const setDraggableRef = draggable.setNodeRef;
  const setDroppableRef = droppable.setNodeRef;
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      elementRef.current = node;
      setDraggableRef(node);
      setDroppableRef(node);
    },
    [setDraggableRef, setDroppableRef],
  );
  const rowStyle = useMemo(() => ({ touchAction: disabled ? "auto" : "pan-y" }), [disabled]);
  const handleStyle = useMemo(
    () => ({
      cursor: disabled ? "default" : "grab",
      display: "flex",
      alignItems: "center",
      width: 14,
      alignSelf: "stretch",
      opacity: disabled ? 0.25 : 0.65,
    }),
    [disabled],
  );
  const handle = useMemo(
    () => (
      <div
        ref={draggable.setActivatorNodeRef}
        {...draggable.attributes}
        {...draggable.listeners}
        aria-label={
          disabled ? "Update host to move or nest workspaces" : "Drag workspace to move or nest"
        }
        data-testid={`workspace-tree-drag-${props.workspace.workspaceKey}`}
        style={handleStyle}
      >
        <ThemedGrip size={12} uniProps={foregroundMutedColorMapping} />
      </div>
    ),
    [disabled, draggable, handleStyle, props.workspace.workspaceKey],
  );
  return (
    <div ref={setRef} {...draggable.listeners} style={rowStyle}>
      <WorkspaceTreeRowChrome {...props} handle={handle} />
    </div>
  );
}
export type { WorkspaceTreeRowProps } from "./row-chrome";
export type { WorkspaceTreeDrop } from "./drop-target";

export const WorkspaceTreeScrollView = ScrollView;

export function WorkspaceTreeProjectList<T>({
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  testID,
}: DraggableListProps<T>) {
  const ids = useMemo(
    () => data.map((item, index) => `project:${keyExtractor(item, index)}`),
    [data, keyExtractor],
  );
  const onProjectDrop = useCallback(
    (activeId: string, overId: string) => {
      const from = ids.indexOf(activeId);
      const to = ids.indexOf(overId);
      if (from >= 0 && to >= 0 && from !== to) onDragEnd(arrayMove(data, from, to));
    },
    [data, ids, onDragEnd],
  );
  return (
    <View testID={testID}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {data.map((item, index) => (
          <WorkspaceTreeProjectItem
            key={ids[index]}
            id={ids[index]!}
            item={item}
            index={index}
            renderItem={renderItem}
            onProjectDrop={onProjectDrop}
          />
        ))}
      </SortableContext>
    </View>
  );
}
function WorkspaceTreeProjectItem<T>({
  id,
  item,
  index,
  renderItem,
  onProjectDrop,
}: {
  id: string;
  item: T;
  index: number;
  renderItem: DraggableListProps<T>["renderItem"];
  onProjectDrop: (activeId: string, overId: string) => void;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data: { kind: "project", onProjectDrop } });
  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition,
      zIndex: isDragging ? 1 : undefined,
      position: "relative" as const,
    }),
    [transform, transition, isDragging],
  );
  const dragHandleProps: DraggableListDragHandleProps = useMemo(
    () => ({
      attributes: attributes as unknown as Record<string, unknown>,
      listeners: listeners as unknown as Record<string, unknown>,
      setActivatorNodeRef: setActivatorNodeRef as (node: unknown) => void,
    }),
    [attributes, listeners, setActivatorNodeRef],
  );
  return (
    <div ref={setNodeRef} style={style}>
      {renderItem({ item, index, drag: noop, isActive: isDragging, dragHandleProps })}
    </div>
  );
}
function noop() {}

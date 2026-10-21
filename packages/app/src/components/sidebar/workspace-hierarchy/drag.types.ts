import type { ReactElement } from "react";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import type { WorkspaceTreeDrop, WorkspaceTreeMove, WorkspaceTreeRow } from "./tree";

export interface WorkspaceTreeRenderInput {
  row: WorkspaceTreeRow;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}
export interface WorkspaceTreeDragProps {
  rows: WorkspaceTreeRow[];
  collapsedKeys: ReadonlySet<string>;
  disabled: boolean;
  canDrag: (row: WorkspaceTreeRow) => boolean;
  onMove: (move: WorkspaceTreeMove) => void;
  renderRow: (input: WorkspaceTreeRenderInput) => ReactElement;
  testID: string;
}
export interface WorkspaceTreeDragState {
  activeKey: string;
  drop: WorkspaceTreeDrop | null;
}

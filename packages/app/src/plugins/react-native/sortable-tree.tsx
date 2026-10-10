import { Fragment } from "react";
import type { SortableTreeProps } from "@getpaseo/plugin/client/ui";
import { visibleTreeItems } from "./sortable-tree-model";

export function SortableTree(props: SortableTreeProps) {
  return visibleTreeItems(props.items).map(({ item, depth }) => (
    <Fragment key={item.id}>{props.renderItem({ id: item.id, depth, dragHandle: null })}</Fragment>
  ));
}

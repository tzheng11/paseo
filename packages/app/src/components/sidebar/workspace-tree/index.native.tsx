import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { Text, View, type NativeSyntheticEvent, type NativeScrollEvent } from "react-native";
import { GripVertical } from "lucide-react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { Gesture, GestureDetector, type ScrollView } from "react-native-gesture-handler";
import { withUnistyles } from "react-native-unistyles";
import {
  WorkspaceTreeController,
  useWorkspaceTreeDrag,
  type WorkspaceTreeProviderProps,
} from "./controller";
import { workspaceDropPosition } from "./drop-target";
import { measureWorkspaceTreeRows, type WorkspaceRowGeometry } from "./native-geometry";
import {
  WorkspaceTreeRowChrome,
  foregroundMutedColorMapping,
  workspaceTreeStyles,
  type WorkspaceTreeRowProps,
} from "./row-chrome";
const frameStyle = { flex: 1 };
const ThemedGrip = withUnistyles(GripVertical);
interface NativeDragRegistry {
  register: (key: string, view: View | null) => void;
  start: (key: string, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  end: (success: boolean) => void;
  registerScroll: (view: ScrollView | null) => void;
  didScroll: (offset: number) => void;
  setContentHeight: (height: number) => void;
}
const NativeRegistryContext = createContext<NativeDragRegistry | null>(null);
export function WorkspaceTreeProvider(props: WorkspaceTreeProviderProps) {
  return (
    <WorkspaceTreeController {...props}>
      <NativeTreeDragSurface>{props.children}</NativeTreeDragSurface>
    </WorkspaceTreeController>
  );
}
function NativeTreeDragSurface({ children }: { children: ReactNode }) {
  const drag = useWorkspaceTreeDrag();
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const nodes = useRef(new Map<string, View>());
  const recomputeTargetRef = useRef<((x: number, y: number) => void) | null>(null);
  const rects = useRef(new Map<string, WorkspaceRowGeometry>());
  const dragSession = useRef(0);
  const dragActive = useRef(false);
  const measurementSequence = useRef(0);
  const appliedMeasurement = useRef(0);
  const frame = useRef<View>(null);
  const frameOrigin = useRef({ x: 0, y: 0, height: 0 });
  const scroll = useRef<ScrollView | null>(null);
  const scrollOffset = useRef(0);
  const contentHeight = useRef(0);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const measure = useCallback(() => {
    if (!dragActive.current) return;
    const session = dragSession.current;
    const sequence = ++measurementSequence.current;
    const isCurrent = () =>
      dragActive.current &&
      dragSession.current === session &&
      sequence > appliedMeasurement.current;
    frame.current?.measureInWindow((x, y, _width, height) => {
      if (
        dragActive.current &&
        dragSession.current === session &&
        sequence >= appliedMeasurement.current
      )
        frameOrigin.current = { x, y, height };
    });
    measureWorkspaceTreeRows(nodes.current, isCurrent, (next) => {
      appliedMeasurement.current = sequence;
      rects.current = next;
      const currentPoint = pointerRef.current;
      if (currentPoint) recomputeTargetRef.current?.(currentPoint.x, currentPoint.y);
    });
  }, []);
  useEffect(
    () => () => {
      dragActive.current = false;
      dragSession.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!drag.activeWorkspaceKey) return;
    measure();
    const timer = setInterval(measure, 120);
    return () => clearInterval(timer);
  }, [drag.activeWorkspaceKey, measure]);
  const register = useCallback((key: string, view: View | null) => {
    if (view) nodes.current.set(key, view);
    else {
      nodes.current.delete(key);
      rects.current.delete(key);
    }
  }, []);
  const start = useCallback(
    (key: string, x: number, y: number) => {
      dragSession.current += 1;
      dragActive.current = true;
      setPointer({ x, y });
      pointerRef.current = { x, y };
      dragRef.current.start(key);
      measure();
    },
    [measure],
  );
  const move = useCallback((x: number, y: number) => {
    setPointer((previous) => (previous?.x === x && previous?.y === y ? previous : { x, y }));
    pointerRef.current = { x, y };
    let target: { key: string; rect: WorkspaceRowGeometry } | null = null;
    for (const [key, rect] of rects.current) {
      if (
        y >= rect.y &&
        y <= rect.y + rect.height &&
        x >= rect.x - 40 &&
        x <= rect.x + rect.width + 40
      ) {
        target = { key, rect };
        break;
      }
    }
    if (target)
      dragRef.current.hover(
        target.key,
        workspaceDropPosition(y - target.rect.y, target.rect.height),
      );
    else dragRef.current.hover("", "inside");
  }, []);
  recomputeTargetRef.current = move;
  const end = useCallback((success: boolean) => {
    dragActive.current = false;
    dragSession.current += 1;
    rects.current.clear();
    setPointer(null);
    pointerRef.current = null;
    if (success) dragRef.current.finish();
    else dragRef.current.cancel();
  }, []);
  const registerScroll = useCallback((view: ScrollView | null) => {
    scroll.current = view;
  }, []);
  const didScroll = useCallback((offset: number) => {
    scrollOffset.current = offset;
  }, []);
  useEffect(() => {
    if (!drag.activeWorkspaceKey) return;
    const timer = setInterval(() => {
      const point = pointerRef.current;
      const bounds = frameOrigin.current;
      if (!point || !scroll.current) return;
      let direction = 0;
      if (point.y < bounds.y + 48) direction = -1;
      else if (point.y > bounds.y + bounds.height - 48) direction = 1;
      if (direction) {
        scrollOffset.current = Math.min(
          Math.max(0, contentHeight.current - bounds.height),
          Math.max(0, scrollOffset.current + direction * 12),
        );
        scroll.current.scrollTo({ y: scrollOffset.current, animated: false });
      }
    }, 40);
    return () => clearInterval(timer);
  }, [drag.activeWorkspaceKey]);
  const setContentHeight = useCallback((height: number) => {
    contentHeight.current = height;
  }, []);
  const value = useMemo(
    () => ({ register, start, move, end, registerScroll, didScroll, setContentHeight }),
    [register, start, move, end, registerScroll, didScroll, setContentHeight],
  );
  const active = drag.workspaces.find(
    (workspace) => workspace.workspaceKey === drag.activeWorkspaceKey,
  );
  return (
    <NativeRegistryContext.Provider value={value}>
      <View ref={frame} style={frameStyle} collapsable={false}>
        {children}
        {active && pointer ? (
          <View
            pointerEvents="none"
            style={[
              workspaceTreeStyles.ghost,
              {
                position: "absolute",
                left: Math.max(0, pointer.x - frameOrigin.current.x + 12),
                top: pointer.y - frameOrigin.current.y + 12,
                zIndex: 1000,
              },
            ]}
          >
            <Text style={workspaceTreeStyles.ghostText}>{active.name}</Text>
          </View>
        ) : null}
      </View>
    </NativeRegistryContext.Provider>
  );
}
export function WorkspaceTreeRow(props: WorkspaceTreeRowProps) {
  const registry = useContext(NativeRegistryContext);
  const drag = useWorkspaceTreeDrag();
  if (!registry) throw new Error("WorkspaceTreeProvider is required");
  const key = props.workspace.workspaceKey;
  const setRef = useCallback((node: View | null) => registry.register(key, node), [key, registry]);
  const enabled = drag.enabled(props.workspace);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activateAfterLongPress(220)
        .runOnJS(true)
        .onStart((event) => registry.start(key, event.absoluteX, event.absoluteY))
        .onUpdate((event) => registry.move(event.absoluteX, event.absoluteY))
        .onEnd((event) => {
          registry.move(event.absoluteX, event.absoluteY);
          registry.end(true);
        })
        .onFinalize((_event, success) => {
          if (!success) registry.end(false);
        }),
    [enabled, key, registry],
  );
  const handle = useMemo(
    () => (
      <GestureDetector gesture={gesture}>
        <View
          accessible
          accessibilityLabel={
            enabled
              ? "Hold and drag workspace to move or nest"
              : "Update host to move or nest workspaces"
          }
          testID={`workspace-tree-drag-${key}`}
          style={workspaceTreeStyles.handle}
        >
          <ThemedGrip size={12} uniProps={foregroundMutedColorMapping} />
        </View>
      </GestureDetector>
    ),
    [enabled, gesture, key],
  );
  return (
    <View ref={setRef} collapsable={false}>
      <WorkspaceTreeRowChrome {...props} handle={handle} />
    </View>
  );
}
export type { WorkspaceTreeRowProps } from "./row-chrome";
export type { WorkspaceTreeDrop } from "./drop-target";

export function WorkspaceTreeScrollView({
  onScrollBeginDrag,
  onScrollEndDrag,
  onMomentumScrollEnd,
  onContentSizeChange,
  ...props
}: ComponentProps<typeof NestableScrollContainer>) {
  const registry = useContext(NativeRegistryContext);
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    registry?.registerScroll(scrollRef.current);
    return () => registry?.registerScroll(null);
  }, [registry]);
  const beginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      registry?.didScroll(event.nativeEvent.contentOffset.y);
      onScrollBeginDrag?.(event);
    },
    [onScrollBeginDrag, registry],
  );
  const endDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      registry?.didScroll(event.nativeEvent.contentOffset.y);
      onScrollEndDrag?.(event);
    },
    [onScrollEndDrag, registry],
  );
  const momentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      registry?.didScroll(event.nativeEvent.contentOffset.y);
      onMomentumScrollEnd?.(event);
    },
    [onMomentumScrollEnd, registry],
  );
  const contentSizeChange = useCallback(
    (width: number, height: number) => {
      registry?.setContentHeight(height);
      onContentSizeChange?.(width, height);
    },
    [onContentSizeChange, registry],
  );
  return (
    <NestableScrollContainer
      {...props}
      ref={scrollRef}
      onScrollBeginDrag={beginDrag}
      onScrollEndDrag={endDrag}
      onMomentumScrollEnd={momentumEnd}
      onContentSizeChange={contentSizeChange}
    />
  );
}

export { DraggableList as WorkspaceTreeProjectList } from "@/components/draggable-list.native";

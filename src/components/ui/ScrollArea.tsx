import { ScrollArea as RadixScrollArea } from "radix-ui";
import {
  useCallback,
  useLayoutEffect,
  useState,
  type ReactNode,
  type Ref,
  type UIEventHandler,
} from "react";
import { cn } from "@/lib/cn";
import { overflowOf } from "./scrollOverflow";

export interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
  /** Classes for the scrolling viewport (padding goes here). */
  viewportClassName?: string;
  /** The viewport element, for scroll position handling (for example log auto-scroll). */
  viewportRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  /** Also allow horizontal scrolling. */
  horizontal?: boolean;
}

/** Sets a callback or object ref. */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * A scroll container with thin overlay scrollbars that look the same on every platform. A
 * scrollbar is only there while the content really overflows (`overflowOf`)
 * (Radix's own check compares rounded heights strictly).
 */
export function ScrollArea({
  children,
  className,
  viewportClassName,
  viewportRef,
  onScroll,
  horizontal,
}: ScrollAreaProps) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ x: false, y: false });
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      setViewport(el);
      assignRef(viewportRef, el);
    },
    [viewportRef],
  );

  useLayoutEffect(() => {
    if (!viewport) return;
    const measure = () => {
      const next = overflowOf(viewport);
      setOverflow((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    // Radix wraps the children in one element: its size is the content size.
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [viewport]);

  return (
    <RadixScrollArea.Root
      type="hover"
      scrollHideDelay={600}
      className={cn("relative overflow-hidden", className)}
    >
      <RadixScrollArea.Viewport
        ref={setRefs}
        onScroll={onScroll}
        className={cn("size-full rounded-[inherit] [&>div]:!block", viewportClassName)}
      >
        {children}
      </RadixScrollArea.Viewport>
      {overflow.y && <Scrollbar orientation="vertical" />}
      {horizontal && overflow.x && <Scrollbar orientation="horizontal" />}
      <RadixScrollArea.Corner />
    </RadixScrollArea.Root>
  );
}

function Scrollbar({ orientation }: { orientation: "vertical" | "horizontal" }) {
  return (
    <RadixScrollArea.Scrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none p-0.5 transition-opacity duration-150 select-none data-[state=hidden]:opacity-0",
        orientation === "vertical" ? "h-full w-2.5" : "h-2.5 flex-col",
      )}
    >
      <RadixScrollArea.Thumb className="relative flex-1 rounded-full bg-fg/25 hover:bg-fg/40" />
    </RadixScrollArea.Scrollbar>
  );
}

import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isFocusReturn } from "./focusReturn";

/** Put once near the root of the app (done in `App.tsx`). */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={450} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  /** The tooltip text; when empty or null the trigger renders without a tooltip. */
  content: ReactNode;
  /** A single focusable element (it receives the trigger props). */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Controlled open state, for example to show a tooltip only when text is truncated. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  open,
  onOpenChange,
  className,
}: TooltipProps) {
  if (content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <RadixTooltip.Root open={open} onOpenChange={onOpenChange}>
      <RadixTooltip.Trigger
        asChild
        onFocus={(event) => {
          // Focus given back by a closing menu or dialog is not the user's: no tooltip for it.
          if (isFocusReturn()) event.preventDefault();
        }}
      >
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "z-50 max-w-[360px] animate-fade-in rounded-md border border-border-strong bg-elevated px-2 py-1 text-sm text-fg shadow-popover break-words text-pretty",
            className,
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

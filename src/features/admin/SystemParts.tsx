/** Small pieces shared by the System page and the program rows of Harness and Model. */
import { CircleCheck, CircleMinus, CircleX } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A found / not found mark with its word. `needed: false` makes a miss quiet instead of red. */
export function Status({
  ok,
  needed = true,
  children,
}: {
  ok: boolean;
  needed?: boolean;
  children: ReactNode;
}) {
  const quiet = !ok && !needed;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-base [&_svg]:size-4",
        ok ? "text-fg" : quiet ? "text-fg-muted" : "text-danger",
      )}
    >
      {ok ? <CircleCheck className="text-success" /> : quiet ? <CircleMinus /> : <CircleX />}
      {children}
    </span>
  );
}

/**
 * "<lead> · <path>" on one line, for the description of a row that has a control at the right:
 * the path is cut with an ellipsis (the full path is its title and is still selectable) instead
 * of wrapping.
 */
export function Located({ lead, path }: { lead: ReactNode; path: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1 pr-2">
      <span className="shrink-0">{lead}</span>
      <span aria-hidden>{"·"}</span>
      <span dir="ltr" data-path title={path} className="min-w-0 truncate font-mono select-text">
        {path}
      </span>
    </span>
  );
}

/** A grey bar where a status will appear, so nothing jumps when it loads. */
export function Placeholder({ className }: { className?: string }) {
  return (
    <span
      className={cn("block h-3.5 w-20 animate-pulse rounded-sm bg-muted", className)}
      aria-hidden
    />
  );
}

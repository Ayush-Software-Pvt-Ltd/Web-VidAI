import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons. */
  action?: ReactNode;
  /** `error` tints the icon. */
  tone?: "neutral" | "error";
  className?: string;
}

/** A centered message for empty, error and "nothing here yet" states. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}
    >
      {icon && (
        <div
          className={cn(
            "mb-3 flex size-10 items-center justify-center rounded-xl [&_svg]:size-5",
            tone === "error" ? "bg-danger-soft text-danger" : "bg-muted text-fg-subtle",
          )}
        >
          {icon}
        </div>
      )}
      <h3 className="text-md font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-[380px] text-base text-fg-muted">{description}</p>}
      {action && <div className="mt-4 flex items-center gap-2">{action}</div>}
    </div>
  );
}

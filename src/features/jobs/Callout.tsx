import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface CalloutProps {
  tone: "warning" | "danger" | "info";
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons under the text. */
  action?: ReactNode;
  className?: string;
}

const tones = {
  warning: { box: "bg-warning-soft", icon: "text-warning" },
  danger: { box: "bg-danger-soft", icon: "text-danger" },
  info: { box: "bg-info-soft", icon: "text-info" },
};

/** An inline message inside a sheet or panel, for something the user should act on. */
export function Callout({ tone, icon, title, children, action, className }: CalloutProps) {
  return (
    <div
      role={tone === "info" ? "note" : "alert"}
      className={cn("flex gap-2.5 rounded-lg px-3 py-2.5", tones[tone].box, className)}
    >
      <span className={cn("mt-px flex shrink-0 [&_svg]:size-4", tones[tone].icon)}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium break-words text-fg">{title}</p>
        {children && <div className="mt-0.5 text-sm break-words text-fg-muted">{children}</div>}
        {action && <div className="mt-2 flex flex-wrap items-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

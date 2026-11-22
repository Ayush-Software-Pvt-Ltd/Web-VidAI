import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { StatusTone } from "@/lib/status";

export type BadgeTone = StatusTone;

const tones: Record<BadgeTone, string> = {
  neutral: "bg-neutral-soft text-fg-muted",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent-text",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
};

const dots: Record<BadgeTone, string> = {
  neutral: "bg-fg-subtle",
  info: "bg-info",
  accent: "bg-accent",
  warning: "bg-warning",
  success: "bg-success",
  danger: "bg-danger",
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** `outline` is for secondary facts such as the video type. */
  variant?: "soft" | "outline";
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Badge({
  tone = "neutral",
  variant = "soft",
  icon,
  children,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3",
        variant === "soft" ? tones[tone] : "border border-border text-fg-muted",
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export interface StatusPillProps {
  tone: BadgeTone;
  label: string;
  /** Pulsing dot while Claude is working. */
  live?: boolean;
  className?: string;
}

/** The status of a video, for example "Editing" or "Needs attention". */
export function StatusPill({ tone, label, live = false, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full pr-2 pl-1.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      <span className="relative flex size-1.5">
        {live && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60",
              dots[tone],
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", dots[tone])} />
      </span>
      {label}
    </span>
  );
}

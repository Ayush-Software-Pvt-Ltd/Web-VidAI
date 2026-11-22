import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

export type ProgressBarTone = "accent" | "muted" | "danger" | "success";

const fills: Record<ProgressBarTone, string> = {
  accent: "bg-accent",
  muted: "bg-fg-subtle",
  danger: "bg-danger",
  success: "bg-success",
};

export interface ProgressBarProps {
  /** 0..100, or `null` when nothing is known yet: only the track shows, and no value is announced. */
  value: number | null;
  tone?: ProgressBarTone;
  /** Accessible name, for example "Progress of 018 Hair Oil, Building graphics". */
  label: string;
  /** Accessible value, for example "46%, paused"; the percent when not given. */
  valueText?: string;
  /** Size, track colour and rounding; the default is a 4 px rounded bar on the muted track. */
  className?: string;
  style?: CSSProperties;
}

/**
 * A determinate progress bar. The fill glides to a new value (instantly with reduced motion), so
 * once-a-second updates read as steady movement rather than jumps.
 */
export function ProgressBar({
  value,
  tone = "accent",
  label,
  valueText,
  className,
  style,
}: ProgressBarProps) {
  const clamped = value === null ? null : Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped === null ? undefined : Math.floor(clamped)}
      aria-valuetext={clamped === null ? undefined : valueText}
      data-tone={tone}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}
      style={style}
    >
      <div
        className={cn(
          "h-full rounded-[inherit] transition-[width,background-color] duration-700 ease-out motion-reduce:transition-none",
          fills[tone],
        )}
        style={{ width: `${clamped ?? 0}%` }}
      />
    </div>
  );
}

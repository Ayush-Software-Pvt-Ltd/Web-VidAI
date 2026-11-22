import { cn } from "@/lib/cn";
import { meterTone } from "./meterTone";

const fills = { normal: "bg-accent", warning: "bg-warning", critical: "bg-danger" };

export interface MeterProps {
  /** 0..100. */
  value: number;
  /** Accessible name, for example "5-hour limit". */
  label: string;
  className?: string;
}

/** A thin horizontal usage bar that changes colour at 70 % and 90 %. */
export function Meter({ value, label, className }: MeterProps) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          fills[meterTone(clamped)],
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

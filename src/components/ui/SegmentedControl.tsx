import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SegmentedOption<V>[];
  "aria-label": string;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}

/** A macOS segmented control: exactly one option is always selected. */
export function SegmentedControl<V extends string = string>({
  value,
  onValueChange,
  options,
  size = "md",
  disabled,
  className,
  ...aria
}: SegmentedControlProps<V>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onValueChange(v as V);
      }}
      disabled={disabled}
      aria-label={aria["aria-label"]}
      className={cn(
        "inline-flex shrink-0 items-center gap-px rounded-md bg-muted p-0.5",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            "focus-ring inline-flex items-center justify-center gap-1 rounded-[5px] font-medium whitespace-nowrap text-fg-muted transition-[background-color,color] duration-100 enabled:hover:text-fg disabled:opacity-45 data-[state=on]:bg-control data-[state=on]:text-fg data-[state=on]:shadow-control [&_svg]:shrink-0",
            size === "sm"
              ? "h-5 px-2 text-sm [&_svg]:size-3"
              : "h-6 px-2.5 text-base [&_svg]:size-3.5",
          )}
        >
          {option.icon}
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

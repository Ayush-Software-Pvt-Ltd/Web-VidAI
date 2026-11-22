import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export interface CheckboxProps extends Omit<ComponentProps<"label">, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The id of a hint or refusal near the checkbox; it goes to the checkbox itself, not the label. */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/**
 * A real checkbox drawn by the app (the `checkbox` utility in `styles.css`, so it looks the same
 * in light and dark mode), with its label: the whole row toggles on click, Space toggles it from
 * the keyboard, and the box shows the focus ring. `aria-describedby` and `aria-invalid` go to the
 * checkbox; other props go to the label, so a `Tooltip` can wrap it.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  children,
  disabled = false,
  className,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...rest
}: CheckboxProps) {
  return (
    <label
      {...rest}
      className={cn(
        "flex cursor-default items-center gap-2 select-none",
        disabled && "opacity-60",
        className,
      )}
    >
      <input
        type="checkbox"
        className="checkbox focus-ring size-4 shrink-0"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          onCheckedChange(event.target.checked);
        }}
      />
      <span className="min-w-0 truncate">{children}</span>
    </label>
  );
}

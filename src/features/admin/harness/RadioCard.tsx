/**
 * One choice of a radio group in a settings box (a "radio card"): a radio, a title, a line, why it
 * cannot be chosen (when it cannot), a badge on the chosen one, a control at the right, and room
 * under the text for more (a note, or the settings of the option). Used by Settings, Harness + API
 * Keys, and meant for the onboarding's choice of options as well.
 */
import { useId, type ReactNode } from "react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/cn";

export function RadioCard({
  name,
  value,
  title,
  description,
  checked,
  disabled,
  reason = null,
  badge = "Used for new edits",
  aside,
  onChoose,
  children,
}: {
  /** The radio group's name. */
  name: string;
  value: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  /** Why it cannot be chosen, shown under the description. */
  reason?: string | null;
  /** Shown next to the title while chosen; `null` shows none. */
  badge?: string | null;
  /** A control at the right of the title row, for example a Configure toggle. */
  aside?: ReactNode;
  onChoose: () => void;
  /** Under the text, aligned with it. */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          aria-describedby={`${id}-description${reason ? ` ${id}-reason` : ""}`}
          onChange={onChoose}
          className="radio focus-ring mt-0.5 size-4 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 items-center gap-2">
            <label
              htmlFor={id}
              className={cn(
                "text-base font-medium text-fg",
                disabled && !checked && "text-fg-muted",
              )}
            >
              {title}
            </label>
            {checked && badge !== null && <Badge tone="accent">{badge}</Badge>}
          </div>
          <p id={`${id}-description`} className="mt-0.5 text-sm text-fg-muted">
            {description}
          </p>
          {reason && (
            <p id={`${id}-reason`} className="mt-1 text-sm text-fg-muted">
              {reason}
            </p>
          )}
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </div>
      {children && <div className="pl-7">{children}</div>}
    </div>
  );
}

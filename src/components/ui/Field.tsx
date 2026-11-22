import { useId, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface FieldProps {
  label: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error text; replaces the hint and is announced. */
  error?: ReactNode;
  /** Text at the right of the label row, for example a character count. */
  aside?: ReactNode;
  /** Receives the generated id: `{(id) => <Input id={id} />}`. */
  children: (id: string, describedBy: string | undefined) => ReactElement;
  className?: string;
}

/** A labelled form row with hint and error text, wired up for screen readers. */
export function Field({ label, hint, error, aside, children, className }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {aside && <span className="text-xs text-fg-subtle tabular">{aside}</span>}
      </div>
      {children(id, note ? noteId : undefined)}
      {note && (
        <p
          id={noteId}
          role={error ? "alert" : undefined}
          className={cn("text-xs", error ? "text-danger" : "text-fg-muted")}
        >
          {note}
        </p>
      )}
    </div>
  );
}

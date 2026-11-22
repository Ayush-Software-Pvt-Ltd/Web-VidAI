import { useId } from "react";
import { useSession } from "@/lib/appEnv";

/** The hint of the Urgent checkbox, word for word from SPEC section 16. */
export const URGENT_HINT =
  "Starts before the other waiting videos, after those already being edited and earlier urgent ones.";

/**
 * The Urgent checkbox of Start Editing and Re-Edit (SPEC sections 8 and 16). Shown only to users
 * who may mark an edit Urgent (`mayMarkUrgent`); everyone else gets nothing (the server refuses
 * Urgent from them with `forbidden` anyway).
 */
export function UrgentField({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const session = useSession();
  const id = useId();
  const hintId = `${id}-hint`;
  if (session?.mayMarkUrgent !== true) return null;
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        className="checkbox focus-ring mt-0.5 size-4 shrink-0"
        checked={checked}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-base font-medium text-fg">
          Urgent
        </label>
        <p id={hintId} className="text-sm text-fg-subtle">
          {URGENT_HINT}
        </p>
      </div>
    </div>
  );
}

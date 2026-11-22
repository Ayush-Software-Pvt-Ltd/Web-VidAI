import type { ReactNode } from "react";
import { Button, Kbd } from "@/components/ui";

export interface SheetFooterProps {
  submitLabel: string;
  /** What Cmd+Enter does, for example "to start". */
  shortcutHint: string;
  submitIcon?: ReactNode;
  /** The id of the form the submit button belongs to. */
  form: string;
  submitting: boolean;
  disabled?: boolean;
  onCancel: () => void;
}

/** The footer of every job sheet: the Cmd+Enter hint, Cancel and the default action. */
export function SheetFooter({
  submitLabel,
  shortcutHint,
  submitIcon,
  form,
  submitting,
  disabled = false,
  onCancel,
}: SheetFooterProps) {
  return (
    <>
      <span className="mr-auto flex items-center gap-1.5 text-sm text-fg-subtle" aria-hidden>
        <Kbd keys={["mod", "enter"]} />
        {shortcutHint}
      </span>
      <Button onClick={onCancel} disabled={submitting}>
        Cancel
      </Button>
      <Button
        type="submit"
        form={form}
        variant="primary"
        icon={submitIcon}
        loading={submitting}
        disabled={disabled}
      >
        {submitLabel}
      </Button>
    </>
  );
}

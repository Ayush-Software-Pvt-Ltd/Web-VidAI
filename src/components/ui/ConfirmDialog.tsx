import { AlertDialog } from "radix-ui";
import { useState, type ReactNode } from "react";
import { Button } from "./Button";
import { quietFocusReturn } from "./focusReturn";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` makes the confirm button red, for destructive actions. */
  tone?: "default" | "danger";
  /** May return a promise: the button shows a spinner and the dialog closes when it resolves. */
  onConfirm: () => void | Promise<void>;
}

/** Asks before doing something important. Esc and Cancel close it. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-overlay" />
        <AlertDialog.Content
          onCloseAutoFocus={quietFocusReturn()}
          className="fixed top-1/2 left-1/2 z-50 w-[380px] max-w-[calc(100vw/var(--page-zoom,1)_-_48px)] -translate-x-1/2 -translate-y-1/2 animate-pop-in rounded-xl bg-elevated p-5 shadow-dialog outline-none"
        >
          <AlertDialog.Title className="text-md font-semibold text-fg">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-base text-fg-muted">
            {description}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={busy}>{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              loading={busy}
              onClick={() => void confirm()}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { Button, Dialog, Field, Input, toast } from "@/components/ui";
import { useApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { changeFieldOf, PASSWORD_RULE, PASSWORDS_DIFFER } from "./rules";

type Fields = "current" | "new" | "repeat";

export interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Change the signed-in person's own password (SPEC section 4): the current password, the new one
 * twice, with the rule in view. The server's refusal is shown at the field it belongs to; on
 * success the dialog closes and a toast says so (the account's other sessions end, this one stays).
 */
export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  // Mounted only while open, so every opening starts with empty fields and no old refusal.
  return open ? <OpenDialog onOpenChange={onOpenChange} /> : null;
}

function OpenDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const api = useApi();
  const formId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const [busy, setBusy] = useState(false);
  const inputs = {
    current: useRef<HTMLInputElement>(null),
    new: useRef<HTMLInputElement>(null),
    repeat: useRef<HTMLInputElement>(null),
  };

  // A refusal puts the focus on the field it is about (the inputs are enabled again by then).
  useEffect(() => {
    const first = (["current", "new", "repeat"] as const).find((name) => errors[name]);
    if (first) inputs[first].current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs are stable
  }, [errors]);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    if (current === "") {
      setErrors({ current: "Enter your current password." });
      return;
    }
    if (next !== repeat) {
      setErrors({ repeat: PASSWORDS_DIFFER });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      toast.success("Password changed");
      onOpenChange(false);
    } catch (caught) {
      const error = toApiError(caught);
      setBusy(false);
      setErrors({ [changeFieldOf(error)]: error.message });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="sm"
      dismissible={!busy}
      title="Change password"
      description="Other browsers where you are signed in will be signed out."
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            Change Password
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        noValidate
        className="flex flex-col gap-3"
      >
        {/* The visible button sits in the footer, outside the form: this one lets Enter submit. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
        <Field label="Current password" error={errors.current}>
          {(id, describedBy) => (
            <Input
              ref={inputs.current}
              id={id}
              name="current-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              aria-describedby={describedBy}
              invalid={errors.current !== undefined}
              value={current}
              disabled={busy}
              onChange={(event) => {
                setCurrent(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="New password" hint={PASSWORD_RULE} error={errors.new}>
          {(id, describedBy) => (
            <Input
              ref={inputs.new}
              id={id}
              name="new-password"
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.new !== undefined}
              value={next}
              disabled={busy}
              onChange={(event) => {
                setNext(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="New password again" error={errors.repeat}>
          {(id, describedBy) => (
            <Input
              ref={inputs.repeat}
              id={id}
              name="new-password-again"
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.repeat !== undefined}
              value={repeat}
              disabled={busy}
              onChange={(event) => {
                setRepeat(event.target.value);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

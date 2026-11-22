import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { Button, Checkbox, Dialog, Field, Input, Select, toast } from "@/components/ui";
import { useApi } from "@/lib/appEnv";
import { toApiError, type ApiError } from "@/lib/errors";
import type { Role, UserAccount } from "@/lib/types";
import { accountFieldOf, PASSWORD_RULE, type AccountField } from "./rules";

const ROLE_OPTIONS = [
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
] as const;

const FIELDS: readonly AccountField[] = ["email", "password", "role", "disabled"];

/**
 * Where a refusal is shown: the field the server named (`email`, `password`, `role`, `disabled`),
 * the top of the form for a name the form has no field for, and for a refusal without a name (the
 * last-admin rules) the sentence decides.
 */
function fieldOfRefusal(error: ApiError): AccountField {
  if (error.field === undefined) return accountFieldOf(error.message);
  return FIELDS.find((name) => name === error.field) ?? "form";
}

export interface UserDialogProps {
  /** `null` creates an account; an account edits it. */
  user: UserAccount | null;
  /** True when the account being edited is the signed-in admin's own. */
  isSelf: boolean;
  onClose: () => void;
  /** Called after the server accepted the change, before the dialog closes. */
  onSaved: () => void;
}

/**
 * Create or edit one account (SPEC section 4). The page mounts it only while it is open, so the
 * typed password is gone as soon as the dialog closes, whichever way it closed. A refusal is shown
 * at the field it belongs to, worded by the server.
 */
export function UserDialog({ user, isSelf, onClose, onSaved }: UserDialogProps) {
  const api = useApi();
  const formId = useId();
  const disabledNoteId = useId();
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(user?.role ?? "user");
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [mayMarkUrgent, setMayMarkUrgent] = useState(user?.mayMarkUrgent ?? true);
  const [errors, setErrors] = useState<Partial<Record<AccountField, string>>>({});
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const roleRow = useRef<HTMLDivElement>(null);
  const disabledRow = useRef<HTMLDivElement>(null);

  // A refusal puts the focus on the field it is about (the controls are enabled again by then).
  useEffect(() => {
    if (errors.email) emailRef.current?.focus();
    else if (errors.password) passwordRef.current?.focus();
    else if (errors.role) roleRow.current?.querySelector("button")?.focus();
    else if (errors.disabled) disabledRow.current?.querySelector("input")?.focus();
  }, [errors]);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setBusy(true);
    try {
      if (user === null) {
        await api.adminCreateUser({ email, password, role, mayMarkUrgent });
        toast.success("Account created", email.trim().toLowerCase());
      } else {
        const patch = {
          id: user.id,
          ...(email.trim() !== user.email ? { email } : {}),
          ...(password !== "" ? { password } : {}),
          ...(role !== user.role ? { role } : {}),
          ...(disabled !== user.disabled ? { disabled } : {}),
          ...(mayMarkUrgent !== user.mayMarkUrgent ? { mayMarkUrgent } : {}),
        };
        if (Object.keys(patch).length > 1) {
          await api.adminUpdateUser(patch);
          toast.success("Account changed", user.email);
        }
      }
      setPassword("");
      onSaved();
      onClose();
    } catch (caught) {
      const error = toApiError(caught);
      setBusy(false);
      setErrors({ [fieldOfRefusal(error)]: error.message });
    }
  }

  const title = user === null ? "New user" : "Edit user";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      dismissible={!busy}
      title={title}
      description={
        user === null
          ? "They sign in with this email and password."
          : "A new password signs the account out of its other browsers."
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            {user === null ? "Create User" : "Save"}
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
        {errors.form && (
          <p role="alert" className="text-sm text-danger">
            {errors.form}
          </p>
        )}
        <Field label="Email" error={errors.email}>
          {(id, describedBy) => (
            <Input
              ref={emailRef}
              id={id}
              name="email"
              type="email"
              autoComplete="off"
              autoFocus
              aria-describedby={describedBy}
              invalid={errors.email !== undefined}
              value={email}
              disabled={busy}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label={user === null ? "Password" : "New password"}
          hint={
            user === null ? PASSWORD_RULE : `Leave empty to keep the password. ${PASSWORD_RULE}`
          }
          error={errors.password}
        >
          {(id, describedBy) => (
            <Input
              ref={passwordRef}
              id={id}
              name="new-password"
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.password !== undefined}
              value={password}
              disabled={busy}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Role"
          hint={
            role === "admin" ? "An admin manages users, limits, storage and the queue." : undefined
          }
          error={errors.role}
        >
          {(id, describedBy) => (
            <div ref={roleRow}>
              <Select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={errors.role !== undefined}
                value={role}
                options={ROLE_OPTIONS}
                disabled={busy}
                onValueChange={(value) => {
                  setRole(value);
                }}
              />
            </div>
          )}
        </Field>
        <Checkbox checked={mayMarkUrgent} disabled={busy} onCheckedChange={setMayMarkUrgent}>
          <span className="text-base">May mark edits as urgent</span>
        </Checkbox>
        {user !== null && (
          <div ref={disabledRow} className="flex flex-col gap-1">
            <Checkbox
              checked={disabled}
              disabled={busy}
              onCheckedChange={setDisabled}
              aria-describedby={disabledNoteId}
              aria-invalid={errors.disabled !== undefined}
            >
              <span className="text-base">
                {isSelf ? "Disabled (your own account)" : "Disabled"}
              </span>
            </Checkbox>
            <p
              id={disabledNoteId}
              role={errors.disabled ? "alert" : undefined}
              className={errors.disabled ? "text-xs text-danger" : "text-xs text-fg-muted"}
            >
              {errors.disabled ??
                "A disabled account cannot sign in, is signed out at once, and its edits are stopped."}
            </p>
          </div>
        )}
      </form>
    </Dialog>
  );
}

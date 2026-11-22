import { CircleAlert, LogIn } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Button, Field, Input } from "@/components/ui";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { AuthCard, AuthPage } from "./AuthCard";

/**
 * The sign-in page (SPEC section 16): email and password in a real form, so the browser's
 * password manager fills it and Enter submits. A refusal is shown under the form in the server's
 * words and keeps the email; the password field is emptied and gets the focus. The sentence the
 * store keeps for a session that ended (`signedOutReason`) is shown above the form until the
 * person signs in. Accounts are made by an administrator, which the page says once, quietly.
 */
export function SignInPage() {
  const store = useAppStoreApi();
  const reason = useAppState((s) => s.signedOutReason);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Set when a refusal should put the focus in the password field once it is enabled again.
  const focusPassword = useRef(false);

  useEffect(() => {
    // Runs after the render that enabled the inputs again: a disabled input cannot take the focus.
    if (busy || !focusPassword.current) return;
    focusPassword.current = false;
    passwordRef.current?.focus();
  }, [busy, error]);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    if (email.trim() === "" || password === "") {
      setError("Enter your email and your password.");
      (email.trim() === "" ? emailRef : passwordRef).current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await store.getState().login(email.trim(), password);
      // The page now shows the app; nothing is left to do here.
    } catch (caught) {
      focusPassword.current = true;
      setError(toApiError(caught).message);
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <AuthPage>
      <AuthCard icon={<LogIn />} title="Sign in to VidAI">
        {reason && (
          <p
            role="status"
            className="mb-4 flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-fg"
          >
            <CircleAlert aria-hidden className="mt-px size-4 shrink-0 text-warning" />
            <span>{reason}</span>
          </p>
        )}
        <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
          <Field label="Email">
            {(id, describedBy) => (
              <Input
                ref={emailRef}
                id={id}
                name="email"
                type="email"
                autoComplete="username"
                autoFocus
                aria-describedby={describedBy}
                value={email}
                disabled={busy}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Password" error={error ?? undefined}>
            {(id, describedBy) => (
              <Input
                ref={passwordRef}
                id={id}
                name="password"
                type="password"
                autoComplete="current-password"
                aria-describedby={describedBy}
                invalid={error !== null}
                value={password}
                disabled={busy}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
            Sign in
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-fg-subtle">
          Accounts are created by an administrator.
        </p>
      </AuthCard>
    </AuthPage>
  );
}

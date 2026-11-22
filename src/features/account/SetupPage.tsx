import { KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Button, Field, Input } from "@/components/ui";
import { useAppStoreApi } from "@/lib/appEnv";
import { isApiError, toApiError } from "@/lib/errors";
import { AuthCard, AuthPage } from "./AuthCard";
import { PASSWORD_RULE, PASSWORDS_DIFFER, setupFieldOf } from "./rules";

/** The one-time token of the setup address (`/setup#<token>`), `null` without one. */
function readSetupToken(hash: string = window.location.hash): string | null {
  const token = decodeURIComponent(hash.replace(/^#/, "")).trim();
  return token === "" ? null : token;
}

/** Takes the token out of the address bar (the page keeps its path and query). */
function forgetToken() {
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}`);
}

type Fields = "email" | "password" | "repeat";

/**
 * The first-admin setup (SPEC section 2, "First admin"): shown only while the server says that no
 * admin exists. The address carries the one-time token the server printed in its own window;
 * without it, or with a refused one, the page only explains where to find the link. The form asks
 * for the email and the password twice, with the password rule in view; on success the person is
 * signed in and the token leaves the address bar.
 */
export function SetupPage() {
  const store = useAppStoreApi();
  const [token, setToken] = useState<string | null>(() => readSetupToken());
  const [refused, setRefused] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const [busy, setBusy] = useState(false);
  const inputs = {
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    repeat: useRef<HTMLInputElement>(null),
  };

  // A refusal puts the focus on the field it is about (the inputs are enabled again by then).
  useEffect(() => {
    const first = (["email", "password", "repeat"] as const).find((name) => errors[name]);
    if (first) inputs[first].current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs are stable
  }, [errors]);

  if (token === null || refused) {
    return (
      <AuthPage>
        <AuthCard
          icon={<KeyRound />}
          tone="warning"
          title={refused ? "This setup link does not work" : "Open the setup link"}
          actions={
            <Button
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload
            </Button>
          }
        >
          <p>
            {refused
              ? "VidAI refused this setup link. It works once and ends when the server stops."
              : "The first administrator is created with a one-time setup link."}
          </p>
          <p className="mt-2">
            The link is printed in the window where VidAI was started. It looks like{" "}
            <code className="font-mono whitespace-nowrap text-fg">/setup#</code> followed by a long
            code. Open that link in this browser.
          </p>
        </AuthCard>
      </AuthPage>
    );
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy || token === null) return;
    if (password !== repeat) {
      setErrors({ repeat: PASSWORDS_DIFFER });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await store.getState().setupAdmin(token, email.trim(), password);
      forgetToken();
    } catch (caught) {
      const error = toApiError(caught);
      setBusy(false);
      if (isApiError(error) && error.code === "forbidden") {
        setRefused(true);
        setToken(null);
        return;
      }
      setErrors({ [setupFieldOf(error)]: error.message });
    }
  }

  return (
    <AuthPage>
      <AuthCard icon={<ShieldCheck />} title="Set up VidAI">
        <p>
          Create the first administrator account. Only an administrator can create other accounts.
        </p>
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="mt-4 flex flex-col gap-3"
        >
          <Field label="Email" error={errors.email}>
            {(id, describedBy) => (
              <Input
                ref={inputs.email}
                id={id}
                name="email"
                type="email"
                autoComplete="username"
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
          <Field label="Password" hint={PASSWORD_RULE} error={errors.password}>
            {(id, describedBy) => (
              <Input
                ref={inputs.password}
                id={id}
                name="password"
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
          <Field label="Password again" error={errors.repeat}>
            {(id, describedBy) => (
              <Input
                ref={inputs.repeat}
                id={id}
                name="password-again"
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
          <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
            Create account
          </Button>
        </form>
      </AuthCard>
    </AuthPage>
  );
}

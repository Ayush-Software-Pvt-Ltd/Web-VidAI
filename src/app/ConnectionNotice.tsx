import { PlugZap } from "lucide-react";
import { AuthCard } from "@/features/account";
import { Button, Spinner } from "@/components/ui";
import { useConnection } from "./useConnection";

/**
 * "VidAI cannot be reached": the card of a server that does not answer (the office network is
 * down, or the server is being restarted). The page keeps trying by itself and says so; the
 * button only reloads sooner.
 */
export function ServerUnreachableCard() {
  return (
    <AuthCard
      icon={<PlugZap />}
      tone="warning"
      title="VidAI cannot be reached"
      footnote={
        <span className="inline-flex items-center gap-2">
          <Spinner size={14} />
          Waiting for VidAI. This page keeps trying and connects by itself.
        </span>
      }
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
        This page cannot reach VidAI right now. Check that you are connected to the office network.
      </p>
      <p className="mt-2">
        Your edits keep running on the server. If this stays for more than a few minutes, ask the
        person who runs VidAI.
      </p>
    </AuthCard>
  );
}

/**
 * A full-page notice over everything while the link to the server is broken (SPEC section 16).
 * Nothing shows while the link is fine. A page whose session ended (`unauthorized`) shows nothing
 * either: the store signs the person out and the sign-in page says why. When the link is back the
 * transport reloads the page only if the server was restarted; otherwise the notice just goes.
 */
export function ConnectionNotice() {
  const { status, unauthorized } = useConnection();
  if (unauthorized || status !== "lost") return null;
  return (
    <div
      role="alert"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-window px-6 py-4"
    >
      <ServerUnreachableCard />
    </div>
  );
}

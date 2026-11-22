import { useState } from "react";
import { Button, Dialog, toast } from "@/components/ui";
import { useApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { pluralize } from "@/lib/format";
import type { UserAccount } from "@/lib/types";

/**
 * Asks before deleting an account, and says what really happens (`server/src/rpc/adminUsers.js`):
 * the person is signed out everywhere, running edits are stopped and waiting ones removed, and
 * their channels leave VidAI. Their folders and files are never deleted. A refusal (the last
 * admin) is shown inside the dialog, which stays open.
 */
export function DeleteUserDialog({
  user,
  isSelf,
  onClose,
  onDeleted,
}: {
  user: UserAccount;
  isSelf: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.adminDeleteUser({ id: user.id });
      toast.success("Account deleted", user.email);
      onDeleted();
      onClose();
    } catch (caught) {
      setBusy(false);
      setError(toApiError(caught).message);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      dismissible={!busy}
      title={`Delete ${user.email}?`}
      description={
        isSelf
          ? "This is your own account: you will be signed out and cannot sign in again."
          : "They are signed out of every browser and cannot sign in again."
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            Delete Account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-base text-fg-muted">
        <p>
          {user.activeJobs > 0
            ? `${pluralize(user.activeJobs, "edit")} of this account ${user.activeJobs === 1 ? "is" : "are"} still active: running edits are stopped and waiting ones are removed.`
            : "This account has no active edits."}{" "}
          Its channels and its history are removed from VidAI.
        </p>
        <p>The folders and files on this computer are not deleted.</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

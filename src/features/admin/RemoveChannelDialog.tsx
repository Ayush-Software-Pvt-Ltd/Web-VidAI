import { useState } from "react";
import { Button, Dialog, toast } from "@/components/ui";
import { useApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import type { AdminChannel } from "@/lib/types";

/**
 * Asks before removing a channel, and says what really happens (SPEC section 6, "Channels"): the
 * channel and its videos leave VidAI, with their edits, change requests and revisions, and the
 * folder and its files stay on the server. A refusal (a job of the channel's videos is still
 * active) is shown inside the dialog, which stays open.
 */
export function RemoveChannelDialog({
  channel,
  onClose,
  onRemoved,
}: {
  channel: AdminChannel;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.adminRemoveChannel({ id: channel.id });
      toast.success("Channel removed", channel.name);
      onRemoved();
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
      title={`Remove ${channel.name}?`}
      description={`It is removed from the channels of ${channel.userEmail}, with its videos' jobs, change requests and revisions.`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            Remove Channel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-base text-fg-muted">
        <p>The folder and its files stay on the server; nothing in it is deleted.</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

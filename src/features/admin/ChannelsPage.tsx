/**
 * Admin, Channels (SPEC sections 6 and 16): every user's channels with their owner, folder, number
 * of videos and whether the folder can be reached; New Channel, Edit and Remove. Only the admin
 * makes, moves and removes channels. Every change is made in a dialog that is mounted only while
 * it is open; the list is loaded again after each change.
 */
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, EmptyState, IconButton, Spinner } from "@/components/ui";
import { useApi, useAppState, useAppStoreApi } from "@/lib/appEnv";
import { pluralize } from "@/lib/format";
import type { AdminChannel } from "@/lib/types";
import { Group, SettingsPage, useLoad } from "@/features/settings";
import { ChannelDialog } from "./ChannelDialog";
import { MiddleText } from "./MiddleText";
import { RemoveChannelDialog } from "./RemoveChannelDialog";

type Dialog = { kind: "create" } | { kind: "edit" | "remove"; channel: AdminChannel };

export function ChannelsPage() {
  const api = useApi();
  const store = useAppStoreApi();
  const channels = useLoad(() => api.adminListChannels());
  const users = useAppState((s) => s.adminUsers);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // The owner choices: ask again for the users every time the page opens.
  useEffect(() => {
    void store.getState().loadAdminUsers();
  }, [store]);

  const { reload } = channels;
  const close = () => {
    setDialog(null);
  };

  if (!channels.data) {
    return (
      <div className="flex h-full items-center justify-center">
        {channels.error ? (
          <EmptyState
            tone="error"
            title="The channels could not be loaded"
            description={channels.error.message}
            action={<Button onClick={() => void reload()}>Try Again</Button>}
          />
        ) : (
          <Spinner label="Loading the channels" />
        )}
      </div>
    );
  }

  return (
    <SettingsPage>
      <Group
        title="Channels"
        description="Each channel is a folder on the server that belongs to one user. Only an admin makes, moves and removes channels."
        aside={
          <Button
            icon={<Plus />}
            disabled={!users.data}
            onClick={() => {
              setDialog({ kind: "create" });
            }}
          >
            New Channel
          </Button>
        }
      >
        {channels.data.length === 0 && (
          <p className="px-4 py-3 text-base text-fg-muted">
            No channels yet. Choose New Channel to give a folder to a user.
          </p>
        )}
        {channels.data.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            onEdit={() => {
              setDialog({ kind: "edit", channel });
            }}
            onRemove={() => {
              setDialog({ kind: "remove", channel });
            }}
          />
        ))}
      </Group>

      {dialog?.kind === "create" && users.data && (
        <ChannelDialog
          channel={null}
          users={users.data}
          onClose={close}
          onSaved={() => void reload()}
        />
      )}
      {dialog?.kind === "edit" && users.data && (
        <ChannelDialog
          channel={dialog.channel}
          users={users.data}
          onClose={close}
          onSaved={() => void reload()}
        />
      )}
      {dialog?.kind === "remove" && (
        <RemoveChannelDialog
          channel={dialog.channel}
          onClose={close}
          onRemoved={() => void reload()}
        />
      )}
    </SettingsPage>
  );
}

function ChannelRow({
  channel,
  onEdit,
  onRemove,
}: {
  channel: AdminChannel;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3" data-testid="channel-row">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span dir="auto" className="min-w-0 truncate text-base font-medium text-fg">
            {channel.name}
          </span>
          {!channel.available && <Badge tone="warning">Unavailable</Badge>}
          {channel.busy && <Badge tone="info">Busy</Badge>}
        </div>
        <div className="mt-0.5 truncate text-sm text-fg-muted">
          {channel.userEmail}
          {channel.available && ` - ${pluralize(channel.videoCount, "video")}`}
        </div>
        <MiddleText path={channel.dir} className="mt-1" />
      </div>
      <Button onClick={onEdit} icon={<Pencil />} aria-label={`Edit ${channel.name}`}>
        Edit
      </Button>
      <IconButton
        label={`Remove ${channel.name}`}
        icon={<Trash2 />}
        variant="ghost"
        onClick={onRemove}
      />
    </div>
  );
}

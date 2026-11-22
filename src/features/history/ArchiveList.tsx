/**
 * Archive (main window, sidebar): every video the signed-in user archived, newest first, each with
 * its channel, its folder name and when it was archived (SPEC section 16).
 * Archiving removes a video from the main list without deleting anything; unarchiving restores its
 * status (the job history is kept). When the server refuses an Unarchive, its sentence is shown
 * under that row.
 */
import { ArchiveRestore, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { Button, toast } from "@/components/ui";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { formatLocalDateTime } from "@/lib/format";
import { Callout, Group, Row, SettingsPage } from "@/features/settings/layout";
import { useAction } from "@/features/settings/useAction";
import type { ArchivedVideo } from "@/lib/types";

function ArchivedRow({ entry }: { entry: ArchivedVideo }) {
  const store = useAppStoreApi();
  const unarchive = useAction(async () => {
    await store.getState().unarchiveVideo(entry.videoId);
    toast.success("Video unarchived", "It is back in the main list.");
  });
  return (
    <Row
      label={
        <span className="flex min-w-0">
          <span className="min-w-0 truncate text-fg-muted">{entry.channelName}</span>
          <span className="shrink-0 whitespace-pre text-fg-subtle"> / </span>
          <span className="min-w-0 truncate">{entry.folderName}</span>
        </span>
      }
      description={
        <span className="text-fg-subtle">Archived {formatLocalDateTime(entry.archivedAt)}</span>
      }
      control={
        <Button
          size="sm"
          icon={<ArchiveRestore />}
          loading={unarchive.pending}
          aria-label={`Unarchive ${entry.folderName}`}
          onClick={() => void unarchive.run()}
        >
          Unarchive
        </Button>
      }
    >
      {unarchive.error && (
        <Callout tone="danger" live title="The video was not unarchived">
          {unarchive.error.message}
        </Callout>
      )}
    </Row>
  );
}

export function ArchiveList() {
  const store = useAppStoreApi();
  const archived = useAppState((s) => s.archived);

  useEffect(() => {
    if (store.getState().archived.status === "idle") void store.getState().loadArchived();
  }, [store]);

  const refresh = useAction(async () => {
    await store.getState().loadArchived();
  });

  const entries = archived.data ?? [];

  return (
    <SettingsPage>
      <Group
        title="Archived videos"
        description="Archive removes an edited or failed video from the main list. Nothing is deleted, and unarchiving restores it. Videos whose folders are deleted disappear from here by themselves."
        aside={
          <Button
            icon={<RefreshCw />}
            loading={refresh.pending || archived.status === "loading"}
            onClick={() => void refresh.run()}
          >
            Refresh
          </Button>
        }
      >
        {archived.status === "loading" && entries.length === 0 ? (
          <p className="px-1 py-3 text-sm text-fg-muted">Loading archived videos…</p>
        ) : entries.length === 0 ? (
          <p className="px-1 py-3 text-sm text-fg-muted">
            Nothing archived. Archive is offered for edited videos and failed edits.
          </p>
        ) : (
          entries.map((entry) => <ArchivedRow key={entry.videoId} entry={entry} />)
        )}
      </Group>
      {(archived.error ?? refresh.error) && (
        <Callout tone="danger" live title="Could not read the archive">
          {(archived.error ?? refresh.error)?.message}
        </Callout>
      )}
    </SettingsPage>
  );
}

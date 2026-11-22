import { useEffect, useState } from "react";
import { ConfirmDialog, Button, Dialog, Spinner } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { formatLocalDateTime } from "@/lib/format";
import type { RevisionView } from "@/lib/types";
import type { Allowance } from "../model";
import { Reasoned } from "./Header";

export interface RevisionsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoId: string;
  restoreAllowance: Allowance;
  onRestore: (n: number) => Promise<void>;
}

function restoreText(n: number): string {
  return `The project goes back to revision ${n}. This is saved as a new revision, and the later revisions stay in the list.`;
}

function who(revision: RevisionView): string {
  if (revision.userEmail) return revision.userEmail;
  return revision.jobId ? "A job" : "Outside VidAI";
}

/** The saved states of the project, newest first, with Restore for any that is not the current one. */
export function Revisions({
  open,
  onOpenChange,
  videoId,
  restoreAllowance,
  onRestore,
}: RevisionsProps) {
  const revisions = useAppState((s) => s.timelines[videoId]?.revisions);
  const load = useAppState((s) => s.loadRevisions);
  const [asking, setAsking] = useState<RevisionView | null>(null);
  useEffect(() => {
    if (open) void load(videoId);
  }, [open, load, videoId]);
  const list = revisions?.data ?? null;
  const ordered = list ? [...list].sort((a, b) => b.n - a.n) : [];
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Revisions"
        description="Every saved state of this project."
        size="md"
      >
        {!list && revisions?.status !== "error" && (
          <div role="status" className="flex items-center gap-2 py-4 text-base text-fg-muted">
            <Spinner size={14} />
            Loading the revisions
          </div>
        )}
        {revisions?.status === "error" && !list && (
          <p role="alert" className="py-4 text-base text-danger">
            {revisions.error?.message ?? "The revisions could not be loaded."}
          </p>
        )}
        {list && (
          <ul aria-label="Revisions" className="divide-y divide-border">
            {ordered.map((revision) => (
              <li
                key={revision.n}
                data-undone={revision.undone || undefined}
                className="flex items-center gap-3 py-2.5"
              >
                <span className="w-8 text-sm text-fg-muted tabular-nums">#{revision.n}</span>
                <div className={revision.undone ? "min-w-0 flex-1 opacity-50" : "min-w-0 flex-1"}>
                  <p className="truncate text-base text-fg">
                    {revision.label}
                    {revision.current && (
                      <span className="ml-2 text-sm font-medium text-accent-text">Current</span>
                    )}
                    {revision.undone && <span className="ml-2 text-sm text-fg-muted">Undone</span>}
                  </p>
                  <p className="truncate text-sm text-fg-muted">
                    {who(revision)} - {formatLocalDateTime(revision.createdAt)}
                  </p>
                </div>
                {!revision.current && (
                  <Reasoned allow={restoreAllowance}>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!restoreAllowance.ok}
                      aria-label={`Restore revision ${revision.n}`}
                      onClick={() => setAsking(revision)}
                    >
                      Restore
                    </Button>
                  </Reasoned>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(next) => !next && setAsking(null)}
        title={asking ? `Restore revision ${asking.n}?` : "Restore"}
        description={asking ? restoreText(asking.n) : ""}
        confirmLabel="Restore"
        onConfirm={async () => {
          if (asking) await onRestore(asking.n);
        }}
      />
    </>
  );
}

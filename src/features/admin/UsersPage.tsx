/**
 * Admin, Users (SPEC section 4): every account with its role, state and active edits; create,
 * edit and delete. Every change is made in a dialog that is mounted only while it is open, so a
 * typed password never outlives it; the list is loaded again after each change.
 */
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, EmptyState, IconButton, Spinner } from "@/components/ui";
import { useAppState, useAppStoreApi, useSession } from "@/lib/appEnv";
import { formatTimeAgo, pluralize } from "@/lib/format";
import type { UserAccount } from "@/lib/types";
import { Group, SettingsPage } from "@/features/settings";
import { DeleteUserDialog } from "./DeleteUserDialog";
import { UserDialog } from "./UserDialog";

type Dialog = { kind: "create" } | { kind: "edit" | "delete"; user: UserAccount };

export function UsersPage() {
  const store = useAppStoreApi();
  const users = useAppState((s) => s.adminUsers);
  const self = useSession();
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    void store.getState().loadAdminUsers();
  }, [store]);

  const reload = () => void store.getState().loadAdminUsers();
  const close = () => {
    setDialog(null);
  };

  if (!users.data) {
    return (
      <div className="flex h-full items-center justify-center">
        {users.status === "error" && users.error ? (
          <EmptyState
            tone="error"
            title="The users could not be loaded"
            description={users.error.message}
            action={<Button onClick={reload}>Try Again</Button>}
          />
        ) : (
          <Spinner label="Loading the users" />
        )}
      </div>
    );
  }

  return (
    <SettingsPage>
      <Group
        title="Accounts"
        description="Everybody who can sign in. Each user has their own channels and videos."
        aside={
          <Button
            icon={<Plus />}
            onClick={() => {
              setDialog({ kind: "create" });
            }}
          >
            New User
          </Button>
        }
      >
        {users.data.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            isSelf={user.id === self?.id}
            onEdit={() => {
              setDialog({ kind: "edit", user });
            }}
            onDelete={() => {
              setDialog({ kind: "delete", user });
            }}
          />
        ))}
      </Group>

      {dialog?.kind === "create" && (
        <UserDialog user={null} isSelf={false} onClose={close} onSaved={reload} />
      )}
      {dialog?.kind === "edit" && (
        <UserDialog
          user={dialog.user}
          isSelf={dialog.user.id === self?.id}
          onClose={close}
          onSaved={reload}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteUserDialog
          user={dialog.user}
          isSelf={dialog.user.id === self?.id}
          onClose={close}
          onDeleted={reload}
        />
      )}
    </SettingsPage>
  );
}

function UserRow({
  user,
  isSelf,
  onEdit,
  onDelete,
}: {
  user: UserAccount;
  isSelf: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3" data-testid="user-row">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-base font-medium text-fg">{user.email}</span>
          {isSelf && <Badge variant="outline">You</Badge>}
          {user.role === "admin" && <Badge tone="accent">Admin</Badge>}
          {user.disabled && <Badge tone="warning">Disabled</Badge>}
        </div>
        <div className="mt-0.5 text-sm text-fg-muted">
          {user.lastSeenAt === null ? "Never signed in" : `Seen ${formatTimeAgo(user.lastSeenAt)}`}
          {" - "}
          {user.activeJobs === 0 ? "no active edits" : pluralize(user.activeJobs, "active edit")}
        </div>
      </div>
      <Button onClick={onEdit} icon={<Pencil />} aria-label={`Edit ${user.email}`}>
        Edit
      </Button>
      <IconButton
        label={`Delete ${user.email}`}
        icon={<Trash2 />}
        variant="ghost"
        onClick={onDelete}
      />
    </div>
  );
}

import { ChevronsUpDown, KeyRound, LogOut, UserRound } from "lucide-react";
import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@/components/ui";
import { returnFocus } from "@/components/ui/focusReturn";
import { useAppStoreApi, useSession } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { ChangePasswordDialog } from "./ChangePasswordDialog";

/**
 * The signed-in person in the sidebar footer: their email (and "Administrator" for an admin) on a
 * button that opens a menu with Change password and Sign out. Takes no props; it shows nothing
 * while nobody is signed in.
 */
export function AccountMenu() {
  const store = useAppStoreApi();
  const user = useSession();
  const [changing, setChanging] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!user) return null;

  const isAdmin = user.role === "admin";

  async function signOut() {
    try {
      await store.getState().logout();
    } catch (error) {
      toast.error("Could not sign out", toApiError(error).message);
    }
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`Account of ${user.email}`}
            className="focus-ring flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-base text-fg hover:bg-hover active:bg-pressed data-[state=open]:bg-selected [&_svg]:size-4"
          >
            <span className="flex shrink-0 text-fg-muted">
              <UserRound aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate" title={user.email}>
              {user.email}
            </span>
            <ChevronsUpDown aria-hidden className="shrink-0 text-fg-subtle" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-[236px]">
          <DropdownMenuLabel>
            <span className="block truncate text-fg">{user.email}</span>
            {isAdmin && <span className="block text-fg-muted">Administrator</span>}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<KeyRound className="size-4" />}
            onSelect={() => {
              setChanging(true);
            }}
          >
            Change password...
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<LogOut className="size-4" />}
            onSelect={() => {
              void signOut();
            }}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog
        open={changing}
        onOpenChange={(open) => {
          setChanging(open);
          if (!open) {
            // Closing a dialog that was opened from a menu gives focus back to the menu button.
            requestAnimationFrame(() => {
              if (triggerRef.current) returnFocus(triggerRef.current);
            });
          }
        }}
      />
    </>
  );
}

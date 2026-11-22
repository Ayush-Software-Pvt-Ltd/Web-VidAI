import { useEffect, useRef } from "react";
import { Button, Kbd, Tooltip } from "@/components/ui";
import { ActivityPanel } from "@/features/activity";
import { ArchiveList, EditLogList } from "@/features/history";
import { JobDialogs } from "@/features/jobs";
import {
  focusVideoRow,
  LibrarySidebar,
  LibraryToolbar,
  ModelControls,
  useSearchShortcut,
  VideoList,
} from "@/features/library";
import { UploadsHost } from "@/features/uploads";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { hasOpenLayer, isEditableTarget } from "@/lib/keyboard";
import { SidebarFooter } from "./SidebarFooter";
import { WindowFrame } from "./WindowFrame";

/**
 * The narrowest the video list gets next to the activity panel: rows with icon-only buttons
 * still show a readable part of the name. The panel shrinks first, down to its own minimum.
 */
const LIST_MIN_WIDTH = 420;

/**
 * The main page (SPEC section 16): the channel sidebar with the usage limits, the account, Archive,
 * Edit Log and Settings at its bottom, the top bar (search, filter and summary on the left; model and
 * effort on the right), the video list and, for the selected video, the activity panel at the
 * right. Archive and Edit Log replace the list and the panel in the content area, with the same
 * sidebar and a Done button (Esc) back to the list. The job sheets and confirmations are mounted
 * once here, and so is `UploadsHost` (Upload Files and the running uploads).
 */
export function MainWindow() {
  useSearchShortcut();
  const view = useAppState((s) => s.view);
  const page = view === "archive" || view === "editLog" ? view : null;
  useReturnFocus(page !== null);
  return (
    <>
      <WindowFrame
        sidebar={<LibrarySidebar />}
        sidebarFooter={<SidebarFooter />}
        topBar={
          page ? (
            <PageTopBar title={page === "archive" ? "Archive" : "Edit Log"} />
          ) : (
            <>
              <LibraryToolbar />
              <div className="flex shrink-0 items-center gap-3 topbar-max-820:gap-2">
                <ModelControls />
              </div>
            </>
          )
        }
        inspector={
          page ? undefined : (
            <ActivityPanel minContentWidth={LIST_MIN_WIDTH} onReturnFocus={focusVideoRow} />
          )
        }
      >
        {page === "archive" ? (
          <ArchiveList />
        ) : page === "editLog" ? (
          <EditLogList />
        ) : (
          <VideoList />
        )}
      </WindowFrame>
      <JobDialogs />
      <UploadsHost />
    </>
  );
}

/**
 * Gives keyboard focus back to what opened Archive or Edit Log (the sidebar entry) when the page
 * closes with Done or Esc, so the person does not start again from the top of the page. A page
 * opened by its address has no opener, and focus is left alone.
 */
function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (!open && wasOpen.current && opener.current?.isConnected) opener.current.focus();
    wasOpen.current = open;
  }, [open]);
}

/** The top bar of Archive and Edit Log: the title and Done, which Esc does too (as in Settings). */
function PageTopBar({ title }: { title: string }) {
  const store = useAppStoreApi();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || hasOpenLayer()) return;
      if (isEditableTarget(event.target)) {
        event.target.blur();
        return;
      }
      event.preventDefault();
      store.getState().setView("main");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [store]);
  return (
    <>
      <h1 className="min-w-0 flex-1 truncate text-md font-semibold">{title}</h1>
      <Tooltip
        content={
          <span className="flex items-center gap-1.5">
            Back to your videos <Kbd keys={["esc"]} />
          </span>
        }
        side="bottom"
      >
        <Button
          variant="primary"
          onClick={() => {
            store.getState().setView("main");
          }}
        >
          Done
        </Button>
      </Tooltip>
    </>
  );
}

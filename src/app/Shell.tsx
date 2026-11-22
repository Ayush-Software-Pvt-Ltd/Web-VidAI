import { CircleAlert } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Button, EmptyState, useToastScreen } from "@/components/ui";
import { SetupPage, SignInPage } from "@/features/account";
import { SettingsView } from "@/features/settings";
import { useApi, useAppState, useAppStoreApi } from "@/lib/appEnv";
import { isNetworkError, type ApiError } from "@/lib/errors";
import { useAppearance } from "./appearance";
import { ConnectionNotice, ServerUnreachableCard } from "./ConnectionNotice";
import { bindHistory } from "./history";
import { LoadingScreen } from "./LoadingScreen";
import { MainWindow } from "./MainWindow";
import { AdminView, DiskCleanupPage, TimelineView } from "./pages";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useRescanOnFocus } from "./useRescanOnFocus";
import { useScreen } from "./useScreen";

/** How long the page waits before it asks the server again while it cannot reach it. */
const RETRY_MS = 4000;
/** The session could not be loaded. A server that does not answer is retried until it does. */
function FatalScreen({ error }: { error: ApiError }) {
  const api = useApi();
  const store = useAppStoreApi();
  const message = error.message;
  const unreachable = isNetworkError(error);
  useEffect(() => {
    if (!unreachable) return;
    let stopped = false;
    const retry = () => {
      api
        .getSession()
        .then((info) => {
          if (!stopped) void store.getState().setSession(info);
        })
        .catch(() => {});
    };
    const timer = setInterval(retry, RETRY_MS);
    window.addEventListener("online", retry);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("online", retry);
    };
  }, [unreachable, api, store]);

  return unreachable ? (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-window px-6 py-4">
      <ServerUnreachableCard />
    </div>
  ) : (
    <div className="flex h-full items-center justify-center bg-window">
      <EmptyState
        tone="error"
        icon={<CircleAlert />}
        title="VidAI could not start"
        description={message}
        action={
          <Button
            onClick={() => {
              window.location.reload();
            }}
          >
            Try Again
          </Button>
        }
      />
    </div>
  );
}

/** Loads the app state, subscribes to server events and shows the right screen for the place. */
export function Shell() {
  const store = useAppStoreApi();
  useEffect(() => store.getState().init(), [store]);
  useEffect(() => bindHistory(store), [store]);
  useAppearance();
  useRescanOnFocus();

  const screen = useScreen();
  const isAdmin = useAppState((s) => s.session.data?.user?.role === "admin");
  const timelineVideoId = useAppState((s) => s.timelineVideoId);
  // Stable primitive for the effects below.
  const kind = screen.kind;
  useGlobalShortcuts(
    kind === "main" ||
      kind === "settings" ||
      kind === "archive" ||
      kind === "editLog" ||
      kind === "diskCleanup",
  );
  useToastScreen(kind);

  let body: ReactNode;
  switch (screen.kind) {
    case "loading":
      body = <LoadingScreen label="Loading VidAI" />;
      break;
    case "fatal":
      body = <FatalScreen error={screen.error} />;
      break;
    case "signIn":
      body = <SignInPage />;
      break;
    case "setup":
      body = <SetupPage />;
      break;
    case "settings":
      body = <SettingsView />;
      break;
    case "admin":
      // The server refuses admin functions to everybody else; the page does not even show it.
      body = isAdmin ? <AdminView /> : <MainWindow />;
      break;
    case "timeline":
      body = timelineVideoId === null ? <MainWindow /> : <TimelineView videoId={timelineVideoId} />;
      break;
    case "diskCleanup":
      body = <DiskCleanupPage />;
      break;
    case "main":
    case "archive":
    case "editLog":
      body = <MainWindow />;
      break;
  }

  return (
    <>
      {body}
      <ConnectionNotice />
    </>
  );
}

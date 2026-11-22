/**
 * The admin area (SPEC section 16): Users, Harness and Model, Queues and Limits, Storage, Queue
 * and System, with their own section navigation in the frame of Settings. Done and Esc return to
 * the video list. The section is the one of the address (`/admin/<section>`, kept in the store as
 * `adminSection`), and every way out - another section, Done, Esc, the browser's Back, closing or
 * reloading the tab - goes through the unsaved-changes guard of the page that has a draft.
 *
 * Only an admin sees it (the shell does not open it for anybody else, and the server refuses every
 * admin function anyway); anybody else who reaches this component gets one sentence.
 */
import { Activity, Cpu, Gauge, HardDrive, ListOrdered, Users } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { pathOf } from "@/app/route";
import { WindowFrame } from "@/app/WindowFrame";
import { Button, EmptyState, Kbd, Tooltip, useToastScreen } from "@/components/ui";
import { useAppStoreApi, useIsAdmin, usePlatform } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { hasOpenLayer, isEditableTarget } from "@/lib/keyboard";
import { isShortcut } from "@/lib/platform";
import type { AdminSection } from "@/lib/store";
import { GuardProvider, useGuard } from "@/features/settings";
import { HarnessPage } from "./harness";
import { QueuePage } from "./QueuePage";
import { QueuesLimitsPage } from "./QueuesLimitsPage";
import { StoragePage } from "./StoragePage";
import { SystemPage } from "./SystemPage";
import { UsersPage } from "./UsersPage";

export const NOT_ADMIN = "Only an admin can open this.";

const SECTIONS: { id: AdminSection; label: string; icon: ReactNode }[] = [
  { id: "users", label: "Users", icon: <Users /> },
  { id: "harness", label: "Harness and Model", icon: <Cpu /> },
  { id: "limits", label: "Queues and Limits", icon: <Gauge /> },
  { id: "storage", label: "Storage", icon: <HardDrive /> },
  { id: "queue", label: "Queue", icon: <ListOrdered /> },
  { id: "system", label: "System", icon: <Activity /> },
];

export function AdminView() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <div className="flex h-full items-center justify-center bg-window">
        <EmptyState title={NOT_ADMIN} />
      </div>
    );
  }
  return (
    <GuardProvider>
      <AdminScreen />
    </GuardProvider>
  );
}

function AdminScreen() {
  const store = useAppStoreApi();
  const { platform, offersShortcut } = usePlatform();
  const { attempt, isDirty } = useGuard();
  const [section, setSection] = useState<AdminSection>(() => store.getState().adminSection);
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  useToastScreen(`admin-${section}`);

  const sectionRef = useRef(section);
  useEffect(() => {
    sectionRef.current = section;
  });
  // Set by a click that already went through the guard, so the store change it causes is not asked again.
  const approved = useRef(false);

  // Follow the store: a section the address changed to (Back, Forward) goes through the guard; a
  // section the user picked here has been through it already.
  useEffect(() => {
    const follow = () => {
      const next = store.getState().adminSection;
      const shown = sectionRef.current;
      if (next === shown) return;
      if (approved.current) {
        approved.current = false;
        setSection(next);
        return;
      }
      attempt(
        () => {
          setSection(next);
        },
        () => {
          // Stay: the address goes back to the section that is still shown.
          if (store.getState().adminSection !== shown) {
            store.getState().goTo({ view: "admin", section: shown });
          }
        },
      );
    };
    follow();
    return store.subscribe(follow);
  }, [store, attempt]);

  const close = () => {
    attempt(() => {
      store.getState().setView("main");
    });
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  const guardRef = useRef({ attempt, isDirty });
  useEffect(() => {
    guardRef.current = { attempt, isDirty };
  });

  // Capture phase on window runs before the app-wide shortcut and before Radix sees Esc.
  const offersSettingsKey = offersShortcut(["mod", ","]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (offersSettingsKey && isShortcut(event, platform, ",")) {
        event.preventDefault();
        event.stopPropagation();
        if (!hasOpenLayer()) closeRef.current();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented || hasOpenLayer()) return;
      if (isEditableTarget(event.target)) {
        event.target.blur();
        return;
      }
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [platform, offersSettingsKey]);

  // The browser's Back and Forward: with unsaved changes the address stays where it was (it is
  // put back before the shell sees the move) and the guard asks; after Save or Discard the move
  // is made as a new step to the place the person asked for.
  const releasing = useRef(false);
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (releasing.current || !guardRef.current.isDirty()) return;
      event.stopImmediatePropagation();
      const wanted = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.history.pushState(
        window.history.state,
        "",
        pathOf({ view: "admin", section: sectionRef.current }),
      );
      guardRef.current.attempt(() => {
        window.history.pushState(null, "", wanted);
        releasing.current = true;
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
        releasing.current = false;
      });
    };
    window.addEventListener("popstate", onPopState, { capture: true });
    return () => {
      window.removeEventListener("popstate", onPopState, { capture: true });
    };
  }, []);

  // Closing or reloading the tab with unsaved changes asks the browser's own question.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!guardRef.current.isDirty()) return;
      event.preventDefault();
      // Browsers that do not act on preventDefault alone need a return value.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  let body: ReactNode;
  switch (section) {
    case "users":
      body = <UsersPage />;
      break;
    case "harness":
      body = <HarnessPage />;
      break;
    case "limits":
      body = <QueuesLimitsPage />;
      break;
    case "storage":
      body = <StoragePage />;
      break;
    case "queue":
      body = <QueuePage />;
      break;
    case "system":
      body = <SystemPage />;
      break;
  }

  return (
    <WindowFrame
      sidebar={
        <nav aria-label="Admin" className="flex flex-col gap-px px-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => {
                if (s.id === section) return;
                attempt(() => {
                  approved.current = true;
                  store.getState().goTo({ view: "admin", section: s.id });
                });
              }}
              className={cn(
                "focus-ring flex h-7 items-center gap-2 rounded-md px-2 text-left text-base text-fg [&_svg]:size-4 [&_svg]:text-fg-muted",
                s.id === section ? "bg-selected" : "hover:bg-hover active:bg-pressed",
              )}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>
      }
      topBar={
        <>
          <h1 className="min-w-0 flex-1 truncate text-md font-semibold">{current?.label}</h1>
          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Back to your videos <Kbd keys={["esc"]} />
              </span>
            }
            side="bottom"
          >
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </Tooltip>
        </>
      }
    >
      <div className="h-full" key={section}>
        {body}
      </div>
    </WindowFrame>
  );
}

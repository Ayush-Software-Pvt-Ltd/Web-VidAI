/**
 * The user's Settings screen (SPEC section 16): Appearance, Channels and Import and Export, with
 * their own section navigation. Done and Esc return to the video list. The section is the one of
 * the address (`/settings/<section>`, kept in the store as `settingsSection`), and every way out
 * - another section, Done, Esc, the browser's Back, closing or reloading the tab - goes through
 * the unsaved-changes guard of the channel editor.
 *
 * `openSettings({ section: "channels", channelId, videoType })` opens a channel: the screen takes
 * that target (from the store's `settingsTarget`) once it mounts, and again whenever a new one
 * arrives while it is open, then clears it.
 *
 * Account actions (change password, sign out) are not a section here: they are in the account menu
 * of the sidebar footer (`@/features/account`).
 */
import { FileDown, Palette, Tv } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { pathOf } from "@/app/route";
import { WindowFrame } from "@/app/WindowFrame";
import { Button, Kbd, Tooltip, useToastScreen } from "@/components/ui";
import { useAppStoreApi, usePlatform } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { hasOpenLayer, isEditableTarget } from "@/lib/keyboard";
import { isShortcut } from "@/lib/platform";
import type { SettingsSection, SettingsTarget } from "@/lib/store";
import type { VideoType } from "@/lib/types";
import { AppearanceSection } from "./AppearanceSection";
import { ChannelsSection } from "./channels/ChannelsSection";
import { useGuard } from "./guardContext";
import { GuardProvider } from "./GuardProvider";
import { ImportExportSection } from "./ImportExportSection";

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "channels", label: "Channels", icon: <Tv /> },
  { id: "importExport", label: "Import and Export", icon: <FileDown /> },
];

/** What the screen shows; `visit` changes on every new target so the section starts fresh. */
interface Place {
  section: SettingsSection;
  channelId: string | null;
  videoType: VideoType | null;
  visit: number;
}

function placeOf(section: SettingsSection, target: SettingsTarget | null, visit: number): Place {
  return {
    section,
    channelId: target?.channelId ?? null,
    videoType: target?.videoType ?? null,
    visit,
  };
}

export function SettingsView() {
  return (
    <GuardProvider>
      <SettingsScreen />
    </GuardProvider>
  );
}

function SettingsScreen() {
  const store = useAppStoreApi();
  const { platform, offersShortcut } = usePlatform();
  const { attempt, isDirty } = useGuard();
  const [opened] = useState(() => store.getState().settingsTarget);
  const [place, setPlace] = useState<Place>(() =>
    placeOf(opened?.section ?? store.getState().settingsSection, opened, 0),
  );
  const current = SECTIONS.find((s) => s.id === place.section) ?? SECTIONS[0];
  const section = current?.id ?? "channels";
  useToastScreen(section);

  const placeRef = useRef(place);
  useEffect(() => {
    placeRef.current = place;
  });
  // Set by a click that already went through the guard, so the store change it causes is not asked again.
  const approved = useRef(false);

  // Follow the store: a target (for example from a sheet that stayed open) or a section the
  // address changed to (Back, Forward) goes through the guard; a section the user picked here
  // has been through it already.
  useEffect(() => {
    const follow = () => {
      const state = store.getState();
      const target = state.settingsTarget;
      if (target) state.clearSettingsTarget();
      if (target !== null && target === opened) return;
      const shown = placeRef.current;
      const next = target
        ? placeOf(target.section, target, shown.visit + 1)
        : state.settingsSection !== shown.section
          ? placeOf(state.settingsSection, null, shown.visit + 1)
          : null;
      if (!next) return;
      if (approved.current) {
        approved.current = false;
        setPlace(next);
        return;
      }
      attempt(
        () => {
          setPlace(next);
        },
        () => {
          // Stay: the address goes back to the section that is still shown.
          if (store.getState().settingsSection !== shown.section) {
            store.getState().goTo({ view: "settings", section: shown.section });
          }
        },
      );
    };
    follow();
    return store.subscribe(follow);
  }, [store, attempt, opened]);

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
        pathOf({ view: "settings", section: placeRef.current.section }),
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
    case "appearance":
      body = <AppearanceSection />;
      break;
    case "channels":
      body = (
        <ChannelsSection initialChannelId={place.channelId} initialVideoType={place.videoType} />
      );
      break;
    case "importExport":
      body = <ImportExportSection />;
      break;
  }

  return (
    <WindowFrame
      sidebar={
        <nav aria-label="Settings" className="flex flex-col gap-px px-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => {
                if (s.id === section) return;
                attempt(() => {
                  approved.current = true;
                  store.getState().goTo({ view: "settings", section: s.id });
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
      <div className="h-full" key={`${section}:${String(place.visit)}`}>
        {body}
      </div>
    </WindowFrame>
  );
}

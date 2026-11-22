/**
 * The one way UI tests get a backend and an app store: every test builds its own `MockBackend`
 * and store, and `render` provides them to components through `AppEnvContext` (`@/lib/appEnv`).
 *
 * ```tsx
 * const app = await setupApp(["default"], { user: "user" });
 * app.render(<VideoList />);
 * app.backend.world.libraryFails = true;   // change the mock world
 * app.store.getState().selectVideo(app.video("018").id);
 * ```
 *
 * `user` is who the page is signed in as: `"admin"` (default), `"user"` or `null` (signed out).
 * Everything set up here is disposed after each test (see `setup.ts`), so tests need no teardown.
 */
import { act, render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";
// Not from "@/components/ui" (its index pulls in `lib/status.ts`, which is not ported yet).
import { TooltipProvider } from "@/components/ui/Tooltip";
import { AppEnvContext } from "@/lib/appEnv";
import { MockBackend, type ScenarioName } from "@/lib/mock";
import { type AppStore, createAppStore } from "@/lib/store";
import type { JobView, VideoView } from "@/lib/types";
import { onTestCleanup } from "./cleanup";

export interface TestApp {
  /** The mock backend, also the `api` the components use. */
  backend: MockBackend;
  store: AppStore;
  /** Renders `ui` with this backend and store (and the tooltip provider the primitives need). */
  render: (ui: ReactElement) => RenderResult;
  /** A video of the loaded library whose folder name starts with `prefix`. */
  video: (prefix: string) => VideoView;
  /** The job of the library video whose folder name starts with `prefix` (throws without one). */
  job: (prefix: string) => JobView;
  /**
   * Runs `times` ticks of the mock (one step of every running job each) and lets the events and
   * the store's refreshes settle. Works with fake timers.
   */
  tick: (times?: number) => Promise<void>;
  /** Stops the store subscriptions and the backend timers (also done after each test). */
  dispose: () => void;
}

export interface SetupOptions {
  /** Who the page is signed in as. Default `"admin"`; `null` is signed out. */
  user?: "admin" | "user" | null;
  /** Changes the mock world before anything loads. */
  prepare?: (backend: MockBackend) => void;
  /** Start the store (`init()`: session, then the signed-in resources) and wait for it. Default true. */
  load?: boolean;
  /** Share the world of another app (a second browser of the same server). */
  world?: MockBackend["world"];
}

export async function setupApp(
  scenarios: ScenarioName[] = ["default"],
  { user = "admin", prepare, load = true, world }: SetupOptions = {},
): Promise<TestApp> {
  const backend = new MockBackend({
    scenarios,
    latencyMs: 0,
    speed: 1,
    autoTick: false,
    as: user,
    ...(world ? { world } : {}),
  });
  prepare?.(backend);
  const store = createAppStore(backend);
  let stop: (() => void) | null = null;
  if (load) {
    await act(async () => {
      stop = store.getState().init();
      await vi.waitFor(() => {
        const s = store.getState();
        const signedIn = s.session.data?.user != null;
        const resources = signedIn
          ? [s.session, s.workspace, s.library, s.queue, s.usage]
          : [s.session];
        if (resources.some((r) => r.status === "idle" || r.status === "loading")) {
          throw new Error("still loading");
        }
      });
    });
  }

  const value = { api: backend, store };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TooltipProvider>
      <AppEnvContext value={value}>{children}</AppEnvContext>
    </TooltipProvider>
  );

  let forget = () => {};
  const app: TestApp = {
    backend,
    store,
    render: (ui) => render(ui, { wrapper }),
    video: (prefix) => {
      for (const channel of store.getState().library.data?.channels ?? []) {
        const found = channel.videos.find((v) => v.folderName.startsWith(prefix));
        if (found) return found;
      }
      throw new Error(`No video starting with ${prefix}`);
    },
    job: (prefix) => {
      const job = app.video(prefix).job;
      if (job === null) throw new Error(`The video starting with ${prefix} has no job`);
      return job;
    },
    tick: async (times = 1) => {
      for (let n = 0; n < times; n += 1) {
        backend.tick();
        for (let spin = 0; spin < 30; spin += 1) await Promise.resolve();
      }
    },
    dispose: () => {
      stop?.();
      stop = null;
      backend.dispose();
      forget();
    },
  };
  forget = onTestCleanup(app.dispose);
  return app;
}

/** `setupApp` and `render` in one step, for tests of a single screen. */
export async function renderApp(
  ui: ReactElement,
  scenarios?: ScenarioName[],
  options?: SetupOptions,
): Promise<TestApp & RenderResult> {
  const app = await setupApp(scenarios, options);
  const result = app.render(ui);
  return { ...app, ...result };
}

/**
 * Test support: like `setupApp` (`@/test/app`), but every call the page makes to the backend is
 * recorded (`calls`) and can be made to fail (`refuse`), so a test can say which command was sent
 * with which ids and how a refusal of the server looks. The mock's own methods cannot be spied on
 * (they are read-only properties), so the store and the components get this wrapper instead.
 */
import { act, render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { Api } from "@/lib/api";
import { AppEnvContext } from "@/lib/appEnv";
import { ApiError } from "@/lib/errors";
import { MockBackend, type ScenarioName } from "@/lib/mock";
// Test support builds its own store, like `src/test/app.tsx`.
// eslint-disable-next-line no-restricted-imports
import { createAppStore, type AppStore } from "@/lib/store";
import type { ErrorCode, VideoView } from "@/lib/types";
import { onTestCleanup } from "@/test/cleanup";
import { jobsControllerFor } from "./env";
import type { JobsController } from "./controller";

export interface RecordedApp {
  backend: MockBackend;
  store: AppStore;
  controller: JobsController;
  render: (ui: ReactElement) => RenderResult;
  /** A video of the loaded library whose folder name starts with `prefix`. */
  video: (prefix: string) => VideoView;
  /** The arguments of every call of command `name`, oldest first. */
  calls: (name: string) => unknown[];
  /** Makes the next call of command `name` fail with this refusal (the command is not run). */
  refuse: (name: string, code: ErrorCode, message: string) => void;
  tick: (times?: number) => Promise<void>;
}

export interface RecordedOptions {
  user?: "admin" | "user";
  scenarios?: ScenarioName[];
  prepare?: (backend: MockBackend) => void;
}

export async function recordedApp({
  user = "admin",
  scenarios = ["default"],
  prepare,
}: RecordedOptions = {}): Promise<RecordedApp> {
  const backend = new MockBackend({
    scenarios,
    latencyMs: 0,
    speed: 1,
    autoTick: false,
    as: user,
  });
  prepare?.(backend);

  const log: Array<{ name: string; args: unknown }> = [];
  const refusals = new Map<string, ApiError[]>();
  const api = new Proxy(
    {},
    {
      // The target is a bare object: the backend's own properties are read-only, and a proxy must
      // return those exactly as they are.
      get(_bare, property) {
        const target = backend;
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function" || typeof property !== "string") return value;
        return (...args: unknown[]) => {
          log.push({ name: property, args: args[0] });
          const refusal = refusals.get(property)?.shift();
          if (refusal) return Promise.reject(refusal);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    },
  ) as Api;

  const store = createAppStore(api);
  let stop: (() => void) | null = store.getState().init();
  await act(async () => {
    await vi.waitFor(() => {
      const s = store.getState();
      const resources = [s.session, s.workspace, s.library, s.queue, s.harness, s.readiness];
      if (resources.some((r) => r.status === "idle" || r.status === "loading")) {
        throw new Error("still loading");
      }
    });
  });
  onTestCleanup(() => {
    stop?.();
    stop = null;
    backend.dispose();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <TooltipProvider>
      <AppEnvContext value={{ api, store }}>{children}</AppEnvContext>
    </TooltipProvider>
  );
  return {
    backend,
    store,
    controller: jobsControllerFor(api, store),
    render: (ui) => render(ui, { wrapper }),
    video: (prefix) => {
      for (const channel of store.getState().library.data?.channels ?? []) {
        const found = channel.videos.find((v) => v.folderName.startsWith(prefix));
        if (found) return found;
      }
      throw new Error(`No video starting with ${prefix}`);
    },
    calls: (name) => log.filter((entry) => entry.name === name).map((entry) => entry.args),
    refuse: (name, code, message) => {
      const list = refusals.get(name) ?? [];
      list.push(new ApiError(code, message));
      refusals.set(name, list);
    },
    tick: async (times = 1) => {
      for (let n = 0; n < times; n += 1) {
        backend.tick();
        for (let spin = 0; spin < 30; spin += 1) await Promise.resolve();
      }
    },
  };
}

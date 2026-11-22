/**
 * What the job dialogs, the activity panel and the library rows depend on: the backend `api` and
 * the app store (from `AppEnvContext`, see `@/lib/appEnv`) and the jobs controller that belongs to
 * that store. There is one controller per store, so every component of a tree (and a test that
 * calls `jobsControllerFor`) sees the same sheets and the same commands in flight.
 */
import type { Api } from "@/lib/api";
import { useAppEnv } from "@/lib/appEnv";
import type { AppStore } from "@/lib/store";
import { createJobsController, type JobsController } from "./controller";

export interface JobsEnv {
  api: Api;
  store: AppStore;
  controller: JobsController;
}

const controllers = new WeakMap<AppStore, JobsController>();

/** The jobs controller of a store, created on first use. */
export function jobsControllerFor(api: Api, store: AppStore): JobsController {
  let controller = controllers.get(store);
  if (!controller) {
    controller = createJobsController(api, store);
    controllers.set(store, controller);
  }
  return controller;
}

export function useJobsEnv(): JobsEnv {
  const { api, store } = useAppEnv();
  return { api, store, controller: jobsControllerFor(api, store) };
}

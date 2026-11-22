/**
 * Picks the backend the app runs on (SPEC section 3): the HTTP backend of the real server in
 * production builds, the in-memory mock in development and tests. In development
 * `?backend=http` switches to the real server through the Vite dev proxy (`vite.config.ts`: it
 * forwards `/api`, `/p` and the player script to the server on `https://127.0.0.1:14200`, or to
 * `VIDAI_SERVER`); the mock is configured from the URL query (`?scenario=`, see
 * `mock/scenarios.ts`).
 *
 * UI code never imports `api` from here: it uses `useApi()` from `@/lib/appEnv` (ESLint
 * enforces it).
 */
import type { Api } from "./api";
import { createHttpApi } from "./http";
import { createMockApi } from "./mock";
import { scenarioOptionsFromSearch } from "./mock/scenarios";

export type { Api, ApiEvents, Unsubscribe } from "./api";
export { ApiError, isAbortError, isApiError, isNetworkError, toApiError } from "./errors";

function createApi(): Api {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const wantsHttp = new URLSearchParams(search).get("backend") === "http";
  if (import.meta.env.DEV && !wantsHttp) return createMockApi(scenarioOptionsFromSearch(search));
  return createHttpApi();
}

export const api: Api = createApi();

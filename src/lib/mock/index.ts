/**
 * The in-memory mock backend (see `backend.ts`) and its scenarios (see `scenarios.ts`).
 *
 * In the browser the active mock is also reachable as `window.vidaiMock` for manual testing, for
 * example `vidaiMock.world.users` or `vidaiMock.tick()`.
 */
import { MockBackend } from "./backend";
import { DEFAULT_MOCK_OPTIONS, type MockOptions } from "./scenarios";

export { MockBackend } from "./backend";
export {
  SCENARIOS,
  scenarioOptionsFromSearch,
  type MockOptions,
  type ScenarioName,
} from "./scenarios";

declare global {
  interface Window {
    vidaiMock?: MockBackend;
  }
}

export function createMockApi(options: Partial<MockOptions> = {}): MockBackend {
  const backend = new MockBackend({ ...DEFAULT_MOCK_OPTIONS, ...options });
  if (typeof window !== "undefined" && import.meta.env.MODE !== "test") window.vidaiMock = backend;
  return backend;
}

import type {
  AdminQueueView,
  AdminSettings,
  ApiModels,
  ApiOption,
  ApiTest,
  HarnessAdminState,
  SystemView,
  UserAccount,
} from "../types";
import { toApiError } from "../errors";
import type { SliceContext } from "./ctx";
import { createTicket, idle, type Resource } from "./resource";

/** One value per API option. */
export type PerOption<T> = Record<ApiOption, T>;

export const perOption = <T>(make: () => T): PerOption<T> => ({
  opencodeGo: make(),
  anthropicApi: make(),
  openaiApi: make(),
});

/**
 * The resources of the admin pages. They are loaded when a page opens (`loadAdmin...`), never
 * for a user; calls of these pages return the new state, which the page hands to the `set...`
 * action so it shows at once.
 */
export interface AdminState {
  adminSettings: Resource<AdminSettings>;
  adminHarness: Resource<HarnessAdminState>;
  adminUsers: Resource<UserAccount[]>;
  adminQueue: Resource<AdminQueueView>;
  adminSystem: Resource<SystemView>;
  /** The model list of each API option at its address, and the result of its latest Test. */
  apiModels: PerOption<Resource<ApiModels>>;
  apiTests: PerOption<Resource<ApiTest>>;
}

export interface AdminActions {
  loadAdminSettings: () => Promise<void>;
  setAdminSettings: (settings: AdminSettings) => void;
  loadAdminHarness: () => Promise<void>;
  setAdminHarness: (state: HarnessAdminState) => void;
  loadAdminUsers: () => Promise<void>;
  loadAdminQueue: () => Promise<void>;
  loadAdminSystem: () => Promise<void>;
  /** The cached list of one option, or the live one with `refresh` (ticketed against stale answers). */
  loadApiModels: (option: ApiOption, refresh?: boolean) => Promise<void>;
  /** Runs Test of one option; the result is in `apiTests[option]`. */
  testApi: (option: ApiOption) => Promise<void>;
  /** Forgets the Test result of one option (also done when its key, address or model changes). */
  clearApiTest: (option: ApiOption) => void;
}

export type AdminSlice = AdminState & AdminActions;

export function createAdminSlice({ api, set, load, generation }: SliceContext): AdminSlice {
  const modelsTicket = perOption(createTicket);
  const testTicket = perOption(createTicket);
  return {
    adminSettings: idle(),
    adminHarness: idle(),
    adminUsers: idle(),
    adminQueue: idle(),
    adminSystem: idle(),
    apiModels: perOption(() => idle<ApiModels>()),
    apiTests: perOption(() => idle<ApiTest>()),
    loadAdminSettings: () => load("adminSettings", () => api.adminGetSettings()),
    setAdminSettings: (data) => set({ adminSettings: { data, status: "ready", error: null } }),
    loadAdminHarness: () => load("adminHarness", () => api.adminGetHarness()),
    setAdminHarness: (data) => set({ adminHarness: { data, status: "ready", error: null } }),
    loadAdminUsers: () => load("adminUsers", () => api.adminListUsers()),
    loadAdminQueue: () => load("adminQueue", () => api.adminGetQueue()),
    loadAdminSystem: () => load("adminSystem", () => api.adminGetSystem()),
    async loadApiModels(option, refresh = false) {
      const ticket = modelsTicket[option].next();
      const was = generation();
      const stale = () => !modelsTicket[option].isCurrent(ticket) || was !== generation();
      set((s) => ({
        apiModels: {
          ...s.apiModels,
          [option]: { ...s.apiModels[option], status: "loading", error: null },
        },
      }));
      try {
        const data = await api.adminGetApiModels({ option, refresh });
        if (stale()) return;
        set((s) => ({
          apiModels: { ...s.apiModels, [option]: { data, status: "ready", error: null } },
        }));
      } catch (error) {
        if (stale()) return;
        set((s) => ({
          apiModels: {
            ...s.apiModels,
            [option]: { ...s.apiModels[option], status: "error", error: toApiError(error) },
          },
        }));
      }
    },
    async testApi(option) {
      const ticket = testTicket[option].next();
      const was = generation();
      const stale = () => !testTicket[option].isCurrent(ticket) || was !== generation();
      set((s) => ({
        apiTests: { ...s.apiTests, [option]: { data: null, status: "loading", error: null } },
      }));
      try {
        const data = await api.adminTestApi({ option });
        if (stale()) return;
        set((s) => ({
          apiTests: { ...s.apiTests, [option]: { data, status: "ready", error: null } },
        }));
      } catch (error) {
        if (stale()) return;
        set((s) => ({
          apiTests: {
            ...s.apiTests,
            [option]: { data: null, status: "error", error: toApiError(error) },
          },
        }));
      }
    },
    clearApiTest(option) {
      testTicket[option].next();
      set((s) => ({ apiTests: { ...s.apiTests, [option]: idle<ApiTest>() } }));
    },
  };
}

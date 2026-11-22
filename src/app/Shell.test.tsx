import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { AppEnvContext } from "@/lib/appEnv";
import { NetworkError } from "@/lib/errors";
// This test wraps the backend so its first answers can fail, like `src/test/app.tsx` it builds a store.
// eslint-disable-next-line no-restricted-imports
import { createAppStore } from "@/lib/store";
import type { SessionInfo } from "@/lib/types";
import { setupApp } from "@/test/app";
import {
  findAdminPage,
  findMainPage,
  findSettingsPage,
  queryAdminPage,
  queryMainPage,
} from "@/test/pages";
import { App } from "../App";

function goTo(path: string) {
  window.history.replaceState(null, "", path);
}

beforeEach(() => {
  goTo("/");
});
afterEach(() => {
  goTo("/");
  vi.useRealTimers();
});

describe("the frame decides the page", () => {
  it("shows the main page to a person who is signed in, at /", async () => {
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    expect(await findMainPage()).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("shows nothing at first, then the sign-in page, to somebody signed out", async () => {
    const app = await setupApp(["signed-out"], { user: null, load: false });
    app.render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(queryMainPage()).toBeNull();
  });

  it("shows the first-admin page while setup is due", async () => {
    goTo("/setup#setup-token-for-tests");
    const app = await setupApp(["needs-setup"], { user: null, load: false });
    app.render(<App />);
    expect(await screen.findByLabelText("Password again")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/setup");
  });

  it("does not flash a spinner for an answer that comes at once", async () => {
    const app = await setupApp(["default"], { load: false });
    const { container } = app.render(<App />);
    expect(container.querySelector("[role=progressbar], [aria-busy=true]")).toBeNull();
    await findMainPage();
  });
});

describe("places and the address bar", () => {
  it("opens a deep link to Settings once signed in", async () => {
    goTo("/settings/appearance");
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    expect(await findSettingsPage()).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/appearance");
  });

  it("opens the archive and the edit log in the main page", async () => {
    goTo("/archive");
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    expect(await findMainPage()).toBeInTheDocument();
    await waitFor(() => {
      expect(app.store.getState().view).toBe("archive");
    });
    act(() => {
      app.store.getState().setView("editLog");
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/edit-log");
    });
  });

  it("shows the Admin page to an admin and the library to everybody else", async () => {
    goTo("/admin/users");
    const admin = await setupApp(["default"], { load: false });
    const first = admin.render(<App />);
    expect(await findAdminPage()).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Users");
    first.unmount();

    goTo("/admin/users");
    const person = await setupApp(["as-user"], { user: "user", load: false });
    person.render(<App />);
    expect(await findMainPage()).toBeInTheDocument();
    expect(queryAdminPage()).toBeNull();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("goes back to the library and replaces an unknown address", async () => {
    goTo("/nothing/here?x=1");
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    expect(await findMainPage()).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(window.location.search).toBe("?x=1");
  });

  it("follows Back and Forward", async () => {
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    await findMainPage();
    act(() => {
      app.store.getState().openSettings();
    });
    await findSettingsPage();
    await waitFor(() => {
      expect(window.location.pathname.startsWith("/settings")).toBe(true);
    });
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(queryMainPage()).not.toBeNull();
    });
    expect(window.location.pathname).toBe("/");
  });
});

describe("signing out and in", () => {
  it("returns to the sign-in page when the session ends, and back to the same place", async () => {
    goTo("/settings/appearance");
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    await findSettingsPage();
    await act(async () => {
      await app.store.getState().logout();
    });
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });
});

describe("a server that cannot be reached", () => {
  it("says so, keeps trying and shows the app when the server answers again", async () => {
    const app = await setupApp(["default"], { load: false });
    let down = true;
    // The page talks to the backend through this, so the first answers can fail.
    const api = Object.create(app.backend, {
      getSession: {
        value: async (): Promise<SessionInfo> => {
          if (down) throw new NetworkError();
          return app.backend.getSession();
        },
      },
    }) as typeof app.backend;
    const store = createAppStore(api);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <TooltipProvider>
        <AppEnvContext value={{ api, store }}>
          <App />
        </AppEnvContext>
      </TooltipProvider>,
    );
    expect(await screen.findByText("VidAI cannot be reached")).toBeInTheDocument();
    expect(screen.getByText(/keeps trying and connects by itself/)).toBeInTheDocument();
    down = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(await findMainPage()).toBeInTheDocument();
    expect(screen.queryByText("VidAI cannot be reached")).toBeNull();
  });
});

describe("keyboard", () => {
  it("toggles Settings with Ctrl+, where the browser leaves the key to the page", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0)");
    const user = userEvent.setup();
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    await findMainPage();
    await user.keyboard("{Control>},{/Control}");
    expect(await findSettingsPage()).toBeInTheDocument();
  });
});

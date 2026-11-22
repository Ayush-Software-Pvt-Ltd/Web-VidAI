/** Test support of the Channels section: a recorded app with the section rendered, and seeds. */
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { Toaster } from "@/components/ui";
import type { MockBackend } from "@/lib/mock";
import { ADMIN_ID } from "@/lib/mock/seed/session";
import { BEAUTY_DIR, HOME, TECH_DIR } from "@/lib/mock/seed/storage";
import { makeChannel } from "@/lib/mock/seed/workspace";
import { recordedApp, type RecordedOptions } from "@/features/jobs/recordedApp";
import { GuardProvider } from "../GuardProvider";
import { ChannelsSection } from "./ChannelsSection";

export const BEAUTY = "Beauty Channel";
export const TECH = "Tech Reviews";

/** The directory of a channel the seed makes for the admin (an admin chose it). */
export const adminDir = (name: string) =>
  name === BEAUTY ? BEAUTY_DIR : name === TECH ? TECH_DIR : `${HOME}/Footage/${name}`;

/** Adds one more channel to the admin's channels (through `prepare`). */
export function addAdminChannel(backend: MockBackend, name: string): string {
  const id = `c0ffee${String(backend.world.channels.length + 1).padStart(26, "0")}`;
  backend.world.channels.push(makeChannel(id, ADMIN_ID, name, adminDir(name)));
  return id;
}

export async function renderChannels(
  options: RecordedOptions = {},
  props: { initialChannelId?: string | null; initialVideoType?: "long" | "short" | null } = {},
) {
  const app = await recordedApp(options);
  app.render(
    <GuardProvider>
      <ChannelsSection {...props} />
      <Toaster />
    </GuardProvider>,
  );
  return { user: userEvent.setup(), ...app };
}

/** The channels of the admin in the mock world, as the server holds them. */
export const adminChannels = (backend: MockBackend) =>
  backend.world.channels.filter((c) => c.userId === ADMIN_ID);

export const channelNamed = (backend: MockBackend, name: string) =>
  adminChannels(backend).find((c) => c.name === name);

export const channelButton = (name: string) =>
  within(screen.getByRole("list", { name: "Channels" })).getByRole("button", {
    name: new RegExp(`^${name}`),
  });

/** The text of every path shown (`PathText` marks its element with `data-path`). */
export const shownPaths = (root: ParentNode = document.body) =>
  [...root.querySelectorAll("[data-path]")].map((el) => el.textContent);

/** The heading of the open channel in the editor (the name is text: only an admin changes it). */
export const openChannel = (name: string) => screen.getByRole("heading", { level: 2, name });

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEnvContext } from "@/lib/appEnv";
import type { MockBackend } from "@/lib/mock";
import type { ChannelsDocument } from "@/lib/types";
import { setupApp } from "@/test/app";
import { readFileText } from "./download";
import { describeImport, exportFileName } from "./channelsFile";
import { ImportExportSection } from "./ImportExportSection";

/** What the page would have downloaded: the file name and the blob behind the link. */
interface Download {
  name: string;
  blob: Blob;
}
let downloads: Download[] = [];

beforeEach(() => {
  downloads = [];
  const blobs = new Map<string, Blob>();
  let count = 0;
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      count += 1;
      const url = `blob:test/${String(count)}`;
      blobs.set(url, blob);
      return url;
    },
    revokeObjectURL: () => {},
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href);
    if (blob) downloads.push({ name: this.download, blob });
  });
});
afterEach(() => {
  vi.useRealTimers();
});

/** The backend, with the two functions of this screen recorded and one of them able to fail. */
function recording(backend: MockBackend) {
  const sent: unknown[] = [];
  const hooks = { exportFails: false };
  // An object that has the backend as its prototype and its own versions of the two functions.
  const api = Object.create(backend, {
    importChannels: {
      value: (input: Parameters<MockBackend["importChannels"]>[0]) => {
        sent.push(input);
        return backend.importChannels(input);
      },
    },
    exportChannels: {
      value: () =>
        hooks.exportFails ? Promise.reject(new Error("offline")) : backend.exportChannels(),
    },
  }) as MockBackend;
  return { api, sent, hooks };
}

async function setup() {
  const app = await setupApp(["default"]);
  const watched = recording(app.backend);
  app.render(
    <AppEnvContext value={{ api: watched.api, store: app.store }}>
      <ImportExportSection />
    </AppEnvContext>,
  );
  return { user: userEvent.setup({ applyAccept: false }), ...app, ...watched };
}

const fileInput = () => screen.getByLabelText<HTMLInputElement>("Channels file");

function jsonFile(content: unknown, name = "channels.json") {
  return new File([typeof content === "string" ? content : JSON.stringify(content)], name, {
    type: "application/json",
  });
}

describe("Export", () => {
  it("downloads the user's channels as one JSON file named with the date", async () => {
    const { user, backend } = await setup();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    expect(downloads[0]?.name).toMatch(/^vidai-channels-\d{4}-\d{2}-\d{2}\.json$/);
    const text = await readFileText(new File([downloads[0]?.blob ?? ""], "x"));
    const document = JSON.parse(text) as ChannelsDocument;
    const expected = await backend.exportChannels();
    expect(document.format).toBe("vidai-channels");
    expect(document.version).toBe(1);
    expect(document.channels).toEqual(expected.channels);
    expect(document.channels.length).toBeGreaterThan(0);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("names the file after the local date", () => {
    expect(exportFileName(new Date(2026, 10, 22, 23, 30))).toBe("vidai-channels-2026-11-22.json");
    expect(exportFileName(new Date(2027, 0, 5))).toBe("vidai-channels-2027-01-05.json");
  });

  it("says why it failed", async () => {
    const { user, hooks } = await setup();
    hooks.exportFails = true;
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByText("The channels were not exported")).toBeInTheDocument();
    expect(downloads).toHaveLength(0);
  });
});

describe("Import", () => {
  it("updates the same-named channels and lists the names that are not the user's", async () => {
    const { user, backend, store } = await setup();
    const document = await backend.exportChannels();
    const first = document.channels[0];
    if (!first) throw new Error("the default scenario has channels");
    const before = store.getState().workspace.data?.channels.length ?? 0;
    const file = jsonFile({
      ...document,
      channels: [first, { ...first, name: "Brand New Channel" }],
    });
    await user.upload(fileInput(), file);
    expect(await screen.findByText("Channels imported")).toBeInTheDocument();
    expect(
      screen.getByText("1 channel updated. Not in your channels: Brand New Channel."),
    ).toBeInTheDocument();
    // An import never makes a channel: only an admin does.
    await waitFor(() => {
      const names = store.getState().workspace.data?.channels.map((c) => c.name) ?? [];
      expect(names).not.toContain("Brand New Channel");
      expect(names).toHaveLength(before);
    });
  });

  it("opens the file chooser from the button and lets the same file be chosen again", async () => {
    const { user } = await setup();
    const click = vi.spyOn(fileInput(), "click");
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(click).toHaveBeenCalledTimes(1);
    await user.upload(fileInput(), jsonFile({ format: "nope" }));
    await screen.findByText("The channels were not imported");
    expect(fileInput().value).toBe("");
  });

  it("refuses a file that is not JSON without asking the server", async () => {
    const { user, sent } = await setup();
    await user.upload(fileInput(), jsonFile("this is not json {"));
    expect(await screen.findByText("The channels were not imported")).toBeInTheDocument();
    expect(screen.getByText("This file is not a VidAI channels file.")).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it("refuses JSON that is not an object", async () => {
    const { user, sent } = await setup();
    await user.upload(fileInput(), jsonFile("[1, 2]"));
    expect(await screen.findByText("This file is not a VidAI channels file.")).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it("refuses a file that is too large", async () => {
    const { user, sent } = await setup();
    const big = jsonFile({ format: "vidai-channels", pad: "x".repeat(1_100_000) });
    await user.upload(fileInput(), big);
    expect(
      await screen.findByText("This file is too large to be a channels file."),
    ).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it("shows the server's refusal as it is", async () => {
    const { user } = await setup();
    await user.upload(fileInput(), jsonFile({ format: "something-else", version: 1 }));
    expect(await screen.findByText("The channels were not imported")).toBeInTheDocument();
    expect(screen.getByText("This is not a VidAI channels file.")).toBeInTheDocument();
    expect(screen.queryByText("Channels imported")).not.toBeInTheDocument();
  });

  it("forgets the last result when the next action starts", async () => {
    const { user, backend } = await setup();
    const document = await backend.exportChannels();
    await user.upload(fileInput(), jsonFile(document));
    expect(await screen.findByText("Channels imported")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.queryByText("Channels imported")).not.toBeInTheDocument();
  });
});

describe("describeImport", () => {
  it("names what happened", () => {
    expect(describeImport({ updated: 1, skipped: [] })).toBe("1 channel updated.");
    expect(describeImport({ updated: 3, skipped: ["A", "B"] })).toBe(
      "3 channels updated. Not in your channels: A, B.",
    );
    expect(describeImport({ updated: 0, skipped: ["A"] })).toBe(
      "No channel was updated. Not in your channels: A.",
    );
    expect(describeImport({ updated: 0, skipped: [] })).toBe(
      "The file had no channels, so nothing changed.",
    );
  });
});

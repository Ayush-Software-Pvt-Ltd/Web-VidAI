import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/app";
import { StoragePage } from "./StoragePage";

async function open(options?: Parameters<typeof renderApp>[2]) {
  const app = await renderApp(<StoragePage />, ["default"], options);
  await screen.findByText("Uploads and previews");
  return app;
}

describe("StoragePage: without folders", () => {
  it("has only the upload size and the preview cache", async () => {
    const app = await open();
    expect(screen.getByLabelText("Largest upload")).toHaveValue(
      String(app.backend.world.adminSettings.maxUploadGb),
    );
    expect(screen.getByLabelText("Preview copies")).toHaveValue(
      String(app.backend.world.adminSettings.proxyCacheGb),
    );
    // Folders are chosen per channel on the Channels page: no list, no way to add or remove one.
    expect(screen.queryByText("Storage folders")).not.toBeInTheDocument();
    expect(screen.queryByTestId("root-row")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Full path of a folder/)).not.toBeInTheDocument();
    expect(app.backend.world.adminSettings).not.toHaveProperty("storageRoots");
  });
});

describe("StoragePage: uploads and previews", () => {
  it("saves the largest upload and the preview cache together, in range", async () => {
    const user = userEvent.setup();
    const app = await open();
    const upload = screen.getByLabelText("Largest upload");
    await user.clear(upload);
    await user.type(upload, "50");
    const cache = screen.getByLabelText("Preview copies");
    await user.clear(cache);
    await user.type(cache, "3000");
    expect(await screen.findByText("Enter a whole number from 1 to 2000.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(cache);
    await user.type(cache, "120");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(app.backend.world.adminSettings).toMatchObject({ maxUploadGb: 50, proxyCacheGb: 120 });
    });
  });
});

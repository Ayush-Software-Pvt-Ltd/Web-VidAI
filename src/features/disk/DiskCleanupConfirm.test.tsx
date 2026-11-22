import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { DiskCleanupConfirm, KEPT_TEXT, type ConfirmVideo } from "./DiskCleanupConfirm";

const GB = 1024 ** 3;
const video = (n: number, gb = 1): ConfirmVideo => ({
  videoId: `v${n}`,
  channelName: "Channel",
  folderName: `Video ${n}`,
  bytes: gb * GB,
});

function show(videos: ConfirmVideo[], onConfirm = vi.fn(() => Promise.resolve())) {
  const onOpenChange = vi.fn();
  render(
    <TooltipProvider>
      <DiskCleanupConfirm videos={videos} onOpenChange={onOpenChange} onConfirm={onConfirm} />
    </TooltipProvider>,
  );
  return { onConfirm, onOpenChange };
}

describe("DiskCleanupConfirm", () => {
  it("is closed without videos", () => {
    show([]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("names one video, the size, what stays and that footage is untouched", () => {
    show([video(1, 2.5)]);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Delete working files?")).toBeInTheDocument();
    expect(within(dialog).getByText("Video 1")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("This frees 2.5 GB.");
    expect(dialog).toHaveTextContent(KEPT_TEXT);
    expect(dialog).toHaveTextContent("Your footage is not touched.");
  });

  it("keeps the SPEC's sentence about what stays and what takes longer", () => {
    expect(KEPT_TEXT).toBe(
      "The timeline, the project and rendered videos stay. A later Re-Edit takes longer because working files are made again.",
    );
  });

  it("lists a few videos with their sizes and the total", () => {
    show([video(1), video(2, 2), video(3, 3)]);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("3 videos will lose their working files. This frees 6.0 GB:");
    expect(within(dialog).getByText("Video 3")).toBeInTheDocument();
    expect(within(dialog).getByText("3.0 GB")).toBeInTheDocument();
  });

  it("only counts when there are many videos", () => {
    show(Array.from({ length: 8 }, (_, n) => video(n)));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      "The working files of 8 videos will be deleted. This frees 8.0 GB.",
    );
    expect(within(dialog).queryByText("Video 3")).not.toBeInTheDocument();
  });

  it("has a destructive button, Cancel focused so Enter deletes nothing", async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = show([video(1)]);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("runs the cleanup from the delete button", async () => {
    const user = userEvent.setup();
    const { onConfirm } = show([video(1)]);
    await user.click(screen.getByRole("button", { name: "Delete Working Files" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./DropdownMenu";
import { IconButton } from "./IconButton";
import { PathText } from "./PathText";
import { ProgressBar } from "./ProgressBar";
import { Select } from "./Select";
import { SegmentedControl } from "./SegmentedControl";
import { Toaster } from "./Toast";
import { toast } from "./toastStore";
import { Tooltip, TooltipProvider } from "./Tooltip";
import { useToastScreen } from "./useToastScreen";

describe("ProgressBar", () => {
  it("reports a clamped whole value, its text and its tone", () => {
    const { rerender } = render(
      <ProgressBar value={46.8} tone="danger" label="Progress of 041" valueText="46%, failed" />,
    );
    const bar = screen.getByRole("progressbar", { name: "Progress of 041" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "46");
    expect(bar).toHaveAttribute("aria-valuetext", "46%, failed");
    expect(bar).toHaveAttribute("data-tone", "danger");
    expect(bar.firstElementChild).toHaveStyle({ width: "46.8%" });

    rerender(<ProgressBar value={140} label="Progress of 041" />);
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("data-tone", "accent");
  });

  it("shows only the track and announces no value while nothing is known", () => {
    render(<ProgressBar value={null} tone="muted" label="Progress of 042" valueText="queued" />);
    const bar = screen.getByRole("progressbar", { name: "Progress of 042" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).not.toHaveAttribute("aria-valuetext");
    expect(bar.firstElementChild).toHaveStyle({ width: "0%" });
  });
});

describe("UI primitives", () => {
  it("Button blocks clicks while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a disabled secondary button looks like a disabled primary one, not faded", () => {
    render(
      <>
        <Button variant="primary" disabled>
          Primary
        </Button>
        <Button disabled>Secondary</Button>
      </>,
    );
    for (const name of ["Primary", "Secondary"]) {
      const { className } = screen.getByRole("button", { name });
      expect(className).toContain("disabled:bg-muted");
      expect(className).toContain("disabled:text-fg-muted");
      expect(className).toContain("disabled:opacity-100");
      expect(className).not.toContain("disabled:opacity-45");
    }
  });

  it("IconButton is named by its label", () => {
    render(
      <TooltipProvider>
        <IconButton label="Refresh" icon={<span />} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("SegmentedControl never deselects", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Filter"
        value="all"
        onValueChange={onChange}
        options={[
          { value: "all", label: "All" },
          { value: "edited", label: "Edited" },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Edited" }));
    expect(onChange).toHaveBeenCalledWith("edited");
  });

  it("ConfirmDialog waits for an async confirm, then closes", async () => {
    const onOpenChange = vi.fn();
    let resolve = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Stop editing?"
        description="The working files are kept."
        confirmLabel="Stop Editing"
        tone="danger"
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Stop Editing" }));
    expect(screen.getByRole("button", { name: "Stop Editing" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    resolve();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  describe("a trigger's tooltip after its menu closes", () => {
    function EffortMenu() {
      return (
        <TooltipProvider>
          <DropdownMenu>
            <Tooltip content="Reasoning effort for new edits">
              <DropdownMenuTrigger asChild>
                <button type="button">Effort</button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent>
              <DropdownMenuItem>High</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button">Elsewhere</button>
        </TooltipProvider>
      );
    }

    let focusSpy: MockInstance<HTMLElement["focus"]>;
    beforeEach(() => {
      focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    });
    afterEach(() => {
      focusSpy.mockRestore();
    });

    /** Lets Radix give focus back (it does so in a timeout after the menu unmounts). */
    async function settle() {
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    }

    it("stays closed when an item is chosen with the mouse", async () => {
      const user = userEvent.setup();
      render(<EffortMenu />);
      const trigger = screen.getByRole("button", { name: "Effort" });
      await user.click(trigger);
      await user.click(await screen.findByRole("menuitem", { name: "High" }));
      await settle();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      // No keyboard focus ring after a mouse choice.
      expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true, focusVisible: false });
    });

    it("stays closed when an item is chosen with the keyboard, but shows on keyboard focus", async () => {
      const user = userEvent.setup();
      render(<EffortMenu />);
      const trigger = screen.getByRole("button", { name: "Effort" });
      await user.tab();
      expect(trigger).toHaveFocus();
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Reasoning effort for new edits",
      );
      await user.keyboard("{Enter}");
      await screen.findByRole("menu");
      await user.keyboard("{Enter}");
      await settle();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true, focusVisible: true });

      // Moving focus away and back is the user's own focus: the tooltip shows again.
      await user.tab();
      await user.tab({ shift: true });
      expect(trigger).toHaveFocus();
      expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    });
  });

  it("toasts close when the user leaves their screen, unless they announce the move", async () => {
    function Screen({ name }: { name: string }) {
      useToastScreen(name);
      return null;
    }
    let kept = 0;
    const { rerender } = render(
      <>
        <Screen name="settings:toolkit" />
        <Toaster />
      </>,
    );
    act(() => {
      toast.success("Your own toolkit is ready", "Choose “My own toolkit” to use it.");
      kept = toast.success("Editing Folder set", "/Users/editor/Editing", { acrossScreens: true });
    });
    expect(screen.getByText("Your own toolkit is ready")).toBeInTheDocument();
    // Re-rendering the same screen keeps them.
    rerender(
      <>
        <Screen name="settings:toolkit" />
        <Toaster />
      </>,
    );
    expect(screen.getByText("Your own toolkit is ready")).toBeInTheDocument();
    rerender(
      <>
        <Screen name="main" />
        <Toaster />
      </>,
    );
    await waitFor(() => {
      expect(screen.queryByText("Your own toolkit is ready")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Editing Folder set")).toBeInTheDocument();
    act(() => {
      toast.leaveScreen();
    });
    expect(screen.getByText("Editing Folder set")).toBeInTheDocument();
    act(() => {
      toast.dismiss(kept);
    });
  });
});

describe("Select and Checkbox pass their description to the control", () => {
  it("Select links a hint or refusal and says when it is invalid", () => {
    render(
      <>
        <Select
          aria-label="Role"
          aria-describedby="role-note"
          aria-invalid
          value="user"
          onValueChange={() => {}}
          options={[{ value: "user", label: "User" }]}
        />
        <p id="role-note">The last admin cannot be made a user.</p>
      </>,
    );
    const select = screen.getByRole("combobox", { name: "Role" });
    expect(select).toHaveAccessibleDescription("The last admin cannot be made a user.");
    expect(select).toBeInvalid();
  });

  it("Select has neither attribute unless asked", () => {
    render(
      <Select
        aria-label="Role"
        value="user"
        onValueChange={() => {}}
        options={[{ value: "user", label: "User" }]}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Role" });
    expect(select).not.toHaveAttribute("aria-describedby");
    expect(select).not.toHaveAttribute("aria-invalid");
  });

  it("Checkbox puts them on the box, not on the label", () => {
    render(
      <>
        <Checkbox checked={false} onCheckedChange={() => {}} aria-describedby="note" aria-invalid>
          Disabled
        </Checkbox>
        <p id="note">The last admin cannot be disabled.</p>
      </>,
    );
    const box = screen.getByRole("checkbox", { name: "Disabled" });
    expect(box).toHaveAccessibleDescription("The last admin cannot be disabled.");
    expect(box).toBeInvalid();
    expect(box.closest("label")).not.toHaveAttribute("aria-describedby");
    expect(box.closest("label")).not.toHaveAttribute("aria-invalid");
  });

  it("Checkbox has neither attribute unless asked", () => {
    render(
      <Checkbox checked onCheckedChange={() => {}}>
        Urgent
      </Checkbox>,
    );
    const box = screen.getByRole("checkbox", { name: "Urgent" });
    expect(box).not.toHaveAttribute("aria-describedby");
    expect(box).not.toHaveAttribute("aria-invalid");
  });
});

describe("PathText", () => {
  it("lets a path wrap only after its separators, and copies as one path", () => {
    const path = "C:\\Users\\editor\\AppData\\Local\\Programs\\Python\\python3.exe";
    const { container } = render(<PathText path={path} />);
    const root = container.querySelector("[data-path]");
    expect(root?.textContent).toBe(path);
    expect(root?.getAttribute("dir")).toBe("ltr");
    // Each name with its separator is one unbreakable block; only a name longer than the line
    // may wrap inside.
    const parts = [...(root?.children ?? [])];
    expect(parts.map((p) => p.textContent)).toEqual([
      "C:\\",
      "Users\\",
      "editor\\",
      "AppData\\",
      "Local\\",
      "Programs\\",
      "Python\\",
      "python3.exe",
    ]);
    for (const part of parts) expect(part).toHaveClass("inline-block", "max-w-full");
  });

  it("selects the whole path on a triple click", () => {
    const path = "/Users/editor/Movies/Editing Folder";
    const { container } = render(<PathText path={path} />);
    const root = container.querySelector("[data-path]");
    if (!(root instanceof HTMLElement)) throw new Error("no path");
    const part = root.lastElementChild;
    if (!part) throw new Error("no part");
    part.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 3 }));
    expect(window.getSelection()?.toString()).toBe(path);
  });
});

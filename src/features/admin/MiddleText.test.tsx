import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui";
import { MiddleText } from "./MiddleText";

function show(path: string) {
  render(
    <TooltipProvider>
      <MiddleText path={path} />
    </TooltipProvider>,
  );
  const whole = screen.getByText(path);
  const visible = Array.from(whole.parentElement?.querySelectorAll("[aria-hidden]") ?? []).map(
    (part) => part.textContent,
  );
  return { whole, visible };
}

describe("MiddleText", () => {
  it("keeps the whole path for assistive technology and the last folder in view", () => {
    const { visible } = show("/Volumes/Footage SSD/Client Shoots/Chess Club");
    expect(visible).toEqual(["/Volumes/Footage SSD/Client Shoots", "/Chess Club"]);
  });

  it("cuts a Windows path before its last folder too", () => {
    const { visible } = show("D:\\Footage\\Beauty Channel");
    expect(visible).toEqual(["D:\\Footage", "\\Beauty Channel"]);
  });

  it("cuts a very long last name in front, and keeps a closing separator with it", () => {
    const long = "x".repeat(50);
    const { visible } = show(`/media/${long}/`);
    expect(visible).toEqual([`/media/${"x".repeat(18)}`, `${"x".repeat(32)}/`]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

/** jsdom has no `execCommand("copy")`; this records what the selection held when it ran. */
function stubExecCommand(result: boolean | "throw") {
  const copied: string[] = [];
  const exec = vi.fn((command: string) => {
    if (result === "throw") throw new Error("denied");
    const area = document.activeElement;
    if (command === "copy" && area instanceof HTMLTextAreaElement) copied.push(area.value);
    return result;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  return { exec, copied };
}

afterEach(() => {
  setClipboard(undefined);
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyText", () => {
  it("uses the Clipboard API when it works", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);
    const { exec } = stubExecCommand(true);
    await copyText("session-1");
    expect(writeText).toHaveBeenCalledWith("session-1");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to the selection when the Clipboard API refuses, and restores focus", async () => {
    setClipboard(() => Promise.reject(new DOMException("Not allowed", "NotAllowedError")));
    const { copied } = stubExecCommand(true);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    await copyText("the whole log");
    expect(copied).toEqual(["the whole log"]);
    expect(document.querySelector("textarea")).toBeNull();
    expect(button).toHaveFocus();
    button.remove();
  });

  it("falls back when there is no Clipboard API at all", async () => {
    setClipboard(undefined);
    const { copied } = stubExecCommand(true);
    await copyText("curl -fsSL https://claude.ai/install.sh | bash");
    expect(copied).toEqual(["curl -fsSL https://claude.ai/install.sh | bash"]);
  });

  it("rejects when neither way works", async () => {
    setClipboard(() => Promise.reject(new Error("no")));
    stubExecCommand(false);
    await expect(copyText("x")).rejects.toThrow("The clipboard is not available.");
    stubExecCommand("throw");
    await expect(copyText("x")).rejects.toThrow("The clipboard is not available.");
    expect(document.querySelector("textarea")).toBeNull();
  });
});

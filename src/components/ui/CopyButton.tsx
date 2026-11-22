import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "@/lib/appEnv";
import { copyText } from "@/lib/clipboard";
import { IconButton, type IconButtonProps } from "./IconButton";
import { toast } from "./toastStore";

export interface CopyButtonProps extends Omit<IconButtonProps, "icon" | "onClick" | "label"> {
  /** The text to copy, or a function that builds it on click. */
  text: string | (() => string);
  /** What it copies, for example "Copy session ID". */
  label: string;
}

const CONFIRM_MS = 1500;

/** Copies text to the clipboard (`copyText`) and confirms with a check mark for a moment. */
export function CopyButton({ text, label, size = "sm", ...rest }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const platform = usePlatform();

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, CONFIRM_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  async function copy() {
    try {
      await copyText(typeof text === "string" ? text : text());
      setCopied(true);
    } catch {
      toast.error(
        "Could not copy",
        `The clipboard is not available. Select the text and press ${platform.shortcut(["mod", "C"])}.`,
      );
    }
  }

  return (
    <IconButton
      label={copied ? "Copied" : label}
      icon={copied ? <Check className="text-success" /> : <Copy />}
      size={size}
      onClick={() => void copy()}
      {...rest}
    />
  );
}

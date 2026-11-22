/**
 * Prompt tools of the channel editor: Reset to Default, Copy from the other type, Copy from
 * another channel. They change the editor only (Save keeps, Revert undoes) and ask first before
 * replacing a prompt that is not empty.
 */
import { ChevronDown, Copy, Files, RotateCcw, Wand2 } from "lucide-react";
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  toast,
} from "@/components/ui";
import { toApiError } from "@/lib/errors";
import type { Channel, VideoType } from "@/lib/types";
import { useApi } from "@/lib/appEnv";
import { quoted, TYPE_LABEL } from "../text";

interface Replacement {
  /** Shown in the confirmation, for example "the default prompt". */
  source: string;
  load: () => Promise<string> | string;
}

export function PromptTools({
  type,
  slot,
  currentPrompt,
  otherTypePrompt,
  otherChannels,
  onReplace,
}: {
  type: VideoType;
  /** The prompt slot shown in the editor; the tools replace its text. */
  slot: number;
  currentPrompt: string;
  /** The prompt of the other type, as it is in the editor now. */
  otherTypePrompt: string;
  otherChannels: Channel[];
  onReplace: (prompt: string) => void;
}) {
  const api = useApi();
  // Kept after closing, so the dialog text does not change while it fades out.
  const [confirm, setConfirm] = useState<Replacement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const otherType: VideoType = type === "long" ? "short" : "long";

  const apply = async (replacement: Replacement) => {
    try {
      onReplace(await replacement.load());
    } catch (error) {
      toast.error("The prompt was not replaced", toApiError(error).message);
    }
  };

  const request = (replacement: Replacement) => {
    if (currentPrompt.trim() === "") void apply(replacement);
    else {
      setConfirm(replacement);
      setConfirmOpen(true);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" icon={<Wand2 />} iconRight={<ChevronDown />}>
            Prompt Tools
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-[260px]">
          <DropdownMenuItem
            icon={<RotateCcw />}
            onSelect={() => {
              request({ source: "the default prompt", load: () => api.getDefaultPrompt() });
            }}
          >
            Reset to Default
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<Copy />}
            disabled={otherTypePrompt.trim() === ""}
            onSelect={() => {
              request({
                source: `the ${TYPE_LABEL[otherType]} prompt of this channel`,
                load: () => otherTypePrompt,
              });
            }}
          >
            Copy from {TYPE_LABEL[otherType]}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={otherChannels.length === 0}>
              <span className="flex items-center gap-2">
                <span className="flex w-4 justify-center opacity-80">
                  <Files />
                </span>
                Copy from Another Channel
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[320px] max-w-[300px] overflow-y-auto">
              {otherChannels.map((channel) => (
                <DropdownMenuItem
                  key={channel.id}
                  disabled={(channel[type].prompts[slot]?.text ?? "").trim() === ""}
                  onSelect={() => {
                    request({
                      source: `the ${TYPE_LABEL[type]} prompt of ${quoted(channel.name)}`,
                      load: () => channel[type].prompts[slot]?.text ?? "",
                    });
                  }}
                >
                  <span dir="auto">{channel.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Replace the ${TYPE_LABEL[type]} prompt?`}
        description={`The prompt in the editor is replaced by ${confirm?.source ?? "another prompt"}. Nothing is saved until you press Save, and Revert brings the saved prompt back.`}
        confirmLabel="Replace Prompt"
        tone="danger"
        onConfirm={async () => {
          if (confirm) await apply(confirm);
        }}
      />
    </>
  );
}

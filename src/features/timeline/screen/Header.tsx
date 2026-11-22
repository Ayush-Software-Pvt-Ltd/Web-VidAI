import type { ReactNode } from "react";
import { ArrowLeft, History, Keyboard, Redo2, Undo2 } from "lucide-react";
import { IconButton } from "@/components/ui";
import type { Allowance } from "../model";

export interface HeaderProps {
  channelName: string | null;
  videoName: string;
  revision: number;
  saving: boolean;
  undo: Allowance;
  redo: Allowance;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRevisions: () => void;
  onHelp: () => void;
}

/** A control that is off keeps its place; the reason is its tooltip (on a wrapper, as a disabled button gets no hover). */
export function Reasoned({ allow, children }: { allow: Allowance; children: ReactNode }) {
  return (
    <span className="inline-flex" title={allow.ok ? undefined : (allow.reason ?? undefined)}>
      {children}
    </span>
  );
}

export function Header({
  channelName,
  videoName,
  revision,
  saving,
  undo,
  redo,
  onBack,
  onUndo,
  onRedo,
  onRevisions,
  onHelp,
}: HeaderProps) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-window px-3">
      <IconButton label="Back to Library" icon={<ArrowLeft />} onClick={onBack} />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-md font-semibold text-fg">
          {channelName && <span className="font-normal text-fg-muted">{channelName} / </span>}
          {videoName}
        </h1>
      </div>
      <span className="text-sm text-fg-muted tabular-nums">Revision {revision}</span>
      <span role="status" className="w-[72px] text-right text-sm text-fg-subtle">
        {saving ? "Saving..." : "Saved"}
      </span>
      <Reasoned allow={undo}>
        <IconButton
          label="Undo"
          icon={<Undo2 />}
          disabled={!undo.ok}
          noTooltip={!undo.ok}
          onClick={onUndo}
        />
      </Reasoned>
      <Reasoned allow={redo}>
        <IconButton
          label="Redo"
          icon={<Redo2 />}
          disabled={!redo.ok}
          noTooltip={!redo.ok}
          onClick={onRedo}
        />
      </Reasoned>
      <IconButton label="Revisions" icon={<History />} onClick={onRevisions} />
      <IconButton label="Keyboard shortcuts" icon={<Keyboard />} onClick={onHelp} />
    </header>
  );
}

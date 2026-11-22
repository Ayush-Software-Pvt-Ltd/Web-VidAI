import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Platform } from "@/lib/platform";
import type { Timeline, TimelineClip } from "@/lib/types";
import {
  canDelete,
  canSplit,
  deleteOp,
  lastFrame,
  splitOp,
  type Allowance,
  type EditGate,
} from "../model";
import type { KeyRegistry } from "../keys";
import type { PlaybackStore } from "../playback";
import type { Edits } from "./useEdits";
import type { PlayerBridge } from "./playerBridge";

export const RATES = [0.5, 1, 1.5, 2];

export interface ShortcutContext {
  platform: Platform;
  /** The keys other parts of the screen claim (`../keys.ts`): C and Escape. */
  keys: KeyRegistry;
  playback: PlaybackStore;
  bridgeRef: RefObject<PlayerBridge | null>;
  timeline: Timeline;
  gate: EditGate;
  selected: TimelineClip | null;
  edits: Edits;
  undo: Allowance;
  redo: Allowance;
  zoomAtPlayhead: (steps: number) => void;
  fit: () => void;
  stepRate: (direction: -1 | 1) => void;
}

function isTyping(target: HTMLElement): boolean {
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Splits the selected clip at the playhead, if the server would allow it. */
export function splitSelected(c: ShortcutContext): void {
  const { selected } = c;
  if (!selected) return;
  const frame = c.playback.getState().frame;
  if (canSplit(selected, frame, c.gate).ok) void c.edits.edit(splitOp(selected, frame));
}

export function deleteSelected(c: ShortcutContext): void {
  const { selected } = c;
  if (selected && canDelete(c.timeline, selected, c.gate).ok) void c.edits.edit(deleteOp(selected));
}

const POPUP = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

/**
 * The keys of the timeline screen, all decided here. Never while a sheet or menu is open. Escape
 * goes to the claims first (a drag, a request being drawn), also from a text field, and nothing
 * else uses it. No other key while a text field has focus, and a key a focused control uses itself
 * (Space on a button) is left to it.
 */
export function useShortcuts(context: ShortcutContext): void {
  const ref = useRef(context);
  useLayoutEffect(() => {
    ref.current = context;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const c = ref.current;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest(POPUP)) return;
      if (event.key === "Escape") {
        if (c.keys.run("Escape")) event.preventDefault();
        return;
      }
      if (target && isTyping(target)) return;
      const mac = c.platform === "macos";
      const mod = mac ? event.metaKey : event.ctrlKey;
      if (event.altKey || (mac ? event.ctrlKey : event.metaKey)) return;
      const key = event.key;
      const lower = key.toLowerCase();
      const frame = c.playback.getState().frame;
      const last = lastFrame(c.timeline.duration);
      const seek = (to: number) => c.playback.seek(Math.min(last, Math.max(0, to)));
      if (mod) {
        if (lower === "z") {
          event.preventDefault();
          const allow = event.shiftKey ? c.redo : c.undo;
          if (allow.ok) void (event.shiftKey ? c.edits.redo() : c.edits.undo());
        } else if (lower === "b" && !event.shiftKey) {
          event.preventDefault();
          splitSelected(c);
        }
        return;
      }
      const button = target?.closest('button,[role="button"],a,summary');
      switch (key) {
        case "c":
        case "C":
          if (event.shiftKey || event.repeat) return;
          if (c.keys.run("c")) event.preventDefault();
          return;
        case " ":
        case "k":
        case "K":
          if (key === " " && button && !target?.closest("[data-clip]")) return;
          event.preventDefault();
          if (!c.playback.getState().ready) return;
          if (c.playback.getState().playing) c.playback.pause();
          else c.playback.play();
          return;
        case "ArrowLeft":
        case "ArrowRight":
          event.preventDefault();
          seek(frame + (key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
          return;
        case "Home":
          event.preventDefault();
          seek(0);
          return;
        case "End":
          event.preventDefault();
          seek(last);
          return;
        case "j":
        case "J":
        case "l":
        case "L":
          if (c.bridgeRef.current?.supportsRate) c.stepRate(lower === "j" ? -1 : 1);
          return;
        case "Delete":
        case "Backspace":
          if (!c.selected) return;
          event.preventDefault();
          deleteSelected(c);
          return;
        case "s":
        case "S":
          if (event.shiftKey) return;
          event.preventDefault();
          splitSelected(c);
          return;
        case "+":
        case "=":
          event.preventDefault();
          c.zoomAtPlayhead(1);
          return;
        case "-":
          event.preventDefault();
          c.zoomAtPlayhead(-1);
          return;
        case "\\":
          event.preventDefault();
          c.fit();
          return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

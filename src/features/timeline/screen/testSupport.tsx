/**
 * Test support of the timeline screen: a fake player bridge that records what the page asks of
 * the player and emits what a player would report, measuring that jsdom cannot do, and a render
 * that wires them to the mock backend (every backend call recorded, see `recordedApp`).
 */
import { act, screen } from "@testing-library/react";
import { vi } from "vitest";
import { Toaster } from "@/components/ui";
import { recordedApp, type RecordedApp, type RecordedOptions } from "@/features/jobs/recordedApp";
import { onTestCleanup } from "@/test/cleanup";
import { TimelineView } from "../TimelineView";
import type { PlayerBridge, PlayerEvent } from "./playerBridge";
import { PlayerEnvContext, type PlayerEnv } from "./playerEnv";

export class FakeBridge implements PlayerBridge {
  supportsRate: boolean;
  /** Everything asked of the player, oldest first (`seek:12`, `play`, `load:<src>`, ...). */
  commands: string[] = [];
  destroyed = false;
  host: HTMLElement | null = null;
  private listeners = new Set<(event: PlayerEvent) => void>();

  constructor(supportsRate = false) {
    this.supportsRate = supportsRate;
  }
  load(src: string): void {
    this.commands.push(`load:${src}`);
  }
  reload(): void {
    this.commands.push("reload");
  }
  play(): void {
    this.commands.push("play");
  }
  pause(): void {
    this.commands.push("pause");
  }
  seek(frame: number): void {
    this.commands.push(`seek:${frame}`);
  }
  setVolume(volume: number): void {
    this.commands.push(`volume:${volume}`);
  }
  setMuted(muted: boolean): void {
    this.commands.push(`muted:${muted}`);
  }
  setRate(rate: number): void {
    this.commands.push(`rate:${rate}`);
  }
  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
  /** What the player reports. */
  emit(event: PlayerEvent): void {
    act(() => {
      for (const listener of [...this.listeners]) listener(event);
    });
  }
  ready(duration = 50): void {
    this.emit({ type: "ready", duration });
  }
  /** The seeks asked for, as frame numbers. */
  seeks(): number[] {
    return this.commands.filter((c) => c.startsWith("seek:")).map((c) => Number(c.slice(5)));
  }
  count(command: string): number {
    return this.commands.filter((c) => c === command).length;
  }
}

/** A measured element: its layout size in CSS px and where its left edge is (layout px). */
interface MeasuredSize {
  width: number;
  height: number;
  left?: number;
}

/**
 * The sizes the page measures: the player area and the tracks viewport (jsdom has no layout).
 * `zoom` is a CSS `zoom` on <html> (the app's text size): like Chromium it makes
 * `getBoundingClientRect` (and so every `clientX`) count in screen px, `zoom` times the layout px
 * that a `ResizeObserver` reports.
 */
export function mockMeasure(
  sizes: Record<string, MeasuredSize> = {
    area: { width: 800, height: 450 },
    tracks: { width: 600, height: 240 },
    body: { width: 1400, height: 800 },
  },
  zoom = 1,
): void {
  const sizeOf = (element: Element): MeasuredSize =>
    sizes[(element as HTMLElement).dataset.measure ?? ""] ?? { width: 0, height: 0 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const size = sizeOf(this);
    const left = (size.left ?? 0) * zoom;
    const width = size.width * zoom;
    const height = size.height * zoom;
    return {
      x: left,
      y: 0,
      left,
      top: 0,
      right: left + width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    };
  });
  class Observer {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      const { width, height } = sizeOf(target);
      const entry = { target, contentRect: { width, height } } as unknown as ResizeObserverEntry;
      this.callback([entry], this);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  onTestCleanup(() => vi.unstubAllGlobals());
}

export interface TimelineTestOptions extends RecordedOptions {
  /** Replaces parts of the player environment (default: a fake bridge, a long ready timeout). */
  env?: Partial<PlayerEnv>;
  rates?: boolean;
  /** The sizes the page measures (see `mockMeasure`); `body` decides side by side or stacked. */
  measure?: Parameters<typeof mockMeasure>[0];
  /** A CSS `zoom` on the page (see `mockMeasure`). */
  zoom?: number;
}

export interface TimelineTest extends RecordedApp {
  bridge: FakeBridge;
  /** The bridges created so far (a new one per player). */
  bridges: FakeBridge[];
  videoId: string;
}

export async function renderTimeline(
  videoId: string,
  { env, rates = false, measure, zoom, ...options }: TimelineTestOptions = {},
): Promise<TimelineTest> {
  mockMeasure(measure, zoom);
  const app = await recordedApp(options);
  const bridges: FakeBridge[] = [];
  const playerEnv: PlayerEnv = {
    loadScript: () => Promise.resolve(),
    createBridge: (host) => {
      const bridge = new FakeBridge(rates);
      bridge.host = host;
      bridges.push(bridge);
      return bridge;
    },
    readyTimeoutMs: 60_000,
    ...env,
  };
  app.render(
    <PlayerEnvContext value={playerEnv}>
      <TimelineView videoId={videoId} />
      <Toaster />
    </PlayerEnvContext>,
  );
  const test: TimelineTest = {
    ...app,
    bridges,
    videoId,
    get bridge() {
      const last = bridges[bridges.length - 1];
      if (!last) throw new Error("The player was not created yet");
      return last;
    },
  };
  return test;
}

/** Waits until the timeline is on screen and the player exists, then reports it ready. */
export async function openReady(test: TimelineTest): Promise<void> {
  await screen.findByTestId("frame-box");
  // A player reports ready only after it was given its address.
  await vi.waitFor(() => {
    if (!test.bridges.some((b) => b.commands.some((c) => c.startsWith("load:")))) {
      throw new Error("the player has no address yet");
    }
  });
  test.bridge.ready();
}

export function clipElement(id: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>("[data-clip]")).find(
    (element) => element.dataset.clip === id,
  );
  if (!found) throw new Error(`No clip ${id} on screen`);
  return found;
}

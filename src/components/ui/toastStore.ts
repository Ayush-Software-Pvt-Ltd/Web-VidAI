/**
 * The toast queue behind `toast` and `<Toaster />`. Usable from anywhere, no hook needed.
 *
 * The rule for every toast: it is feedback about something that just happened on the screen the
 * user is looking at, so it closes when the user leaves that screen (another top-level screen, an
 * onboarding step or a Settings section; see `useToastScreen`), and its wording never depends on
 * where things are ("below", "on the left"). Only a toast that announces the move to another
 * screen itself sets `acrossScreens`.
 */
export type ToastTone = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Optional button, for example "Undo" or "Show". */
  action?: { label: string; onClick: () => void };
  durationMs: number;
  /** Stays when the screen changes (default false: it closes with its screen). */
  acrossScreens?: boolean;
}

type Listener = () => void;
let items: ToastItem[] = [];

export function getToasts(): ToastItem[] {
  return items;
}
let nextId = 1;
const listeners = new Set<Listener>();

function publish(next: ToastItem[]) {
  items = next;
  for (const l of listeners) l();
}

function show(
  tone: ToastTone,
  title: string,
  options: Partial<Omit<ToastItem, "id" | "tone" | "title">> = {},
): number {
  const id = nextId++;
  const item: ToastItem = {
    id,
    tone,
    title,
    durationMs: tone === "error" ? 8000 : 4000,
    ...options,
  };
  publish([...items.slice(-3), item]);
  return id;
}

/**
 * Shows a transient notification from anywhere (no hook needed):
 * `toast.success("Saved")`, `toast.error("Could not start", err.message)`.
 */
export const toast = {
  info: (title: string, description?: string, options?: Partial<ToastItem>) =>
    show("info", title, { description, ...options }),
  success: (title: string, description?: string, options?: Partial<ToastItem>) =>
    show("success", title, { description, ...options }),
  error: (title: string, description?: string, options?: Partial<ToastItem>) =>
    show("error", title, { description, ...options }),
  dismiss: (id: number) => {
    publish(items.filter((t) => t.id !== id));
  },
  /** Closes the toasts of the screen the user just left (all but `acrossScreens` ones). */
  leaveScreen: () => {
    const kept = items.filter((t) => t.acrossScreens === true);
    if (kept.length !== items.length) publish(kept);
  },
};

export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

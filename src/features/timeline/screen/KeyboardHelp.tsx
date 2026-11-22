import { Dialog, Kbd } from "@/components/ui";

interface Row {
  keys: string[][];
  text: string;
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Playback",
    rows: [
      { keys: [["Space"], ["K"]], text: "Play or pause" },
      { keys: [["←"], ["→"]], text: "One frame back or forward" },
      {
        keys: [
          ["Shift", "←"],
          ["Shift", "→"],
        ],
        text: "Ten frames back or forward",
      },
      { keys: [["Home"], ["End"]], text: "To the start or the end" },
      { keys: [["J"], ["L"]], text: "Slower or faster, where the player allows it" },
    ],
  },
  {
    title: "Timeline",
    rows: [
      { keys: [["Tab"]], text: "Move into the tracks" },
      { keys: [["←"], ["→"], ["↑"], ["↓"]], text: "Next clip, while a clip has focus" },
      { keys: [["+"], ["-"], ["\\"]], text: "Zoom in, zoom out, fit to width" },
    ],
  },
  {
    title: "Editing",
    rows: [
      { keys: [["S"], ["mod", "B"]], text: "Split the selected clip at the playhead" },
      { keys: [["Delete"], ["Backspace"]], text: "Delete the selected clip" },
      { keys: [["esc"]], text: "Cancel a drag" },
      { keys: [["mod", "Z"]], text: "Undo" },
      { keys: [["Shift", "mod", "Z"]], text: "Redo" },
    ],
  },
];

export function KeyboardHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" size="md">
      <div className="space-y-4">
        {GROUPS.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3 className="mb-1.5 text-sm font-semibold text-fg-muted">{group.title}</h3>
            <ul className="space-y-1.5">
              {group.rows.map((row) => (
                <li key={row.text} className="flex items-center justify-between gap-4">
                  <span className="text-base text-fg">{row.text}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {row.keys.map((keys) => (
                      <Kbd key={keys.join("+")} keys={keys} />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

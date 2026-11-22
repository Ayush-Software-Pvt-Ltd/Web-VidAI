/**
 * Every UI primitive in every state, for visual review (`?gallery=1`, dev builds only).
 * `npm run screenshots` captures it in light and dark mode. Add new primitives here.
 */
import {
  Copy,
  Ellipsis,
  FolderSearch,
  Inbox,
  Pause,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Wand2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { usePlatform } from "@/lib/appEnv";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  Meter,
  ProgressBar,
  ScrollArea,
  SegmentedControl,
  Select,
  Sheet,
  Spinner,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
  Tooltip,
  TruncatedText,
  type ButtonVariant,
  type ProgressBarTone,
} from "@/components/ui";
import type { StatusTone } from "@/lib/status";

type Theme = "system" | "light" | "dark";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-separator pb-6">
      <h2 className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label && <span className="w-24 shrink-0 text-sm text-fg-muted">{label}</span>}
      {children}
    </div>
  );
}

/** Every state of a job's progress bar (SPEC section 9, Main window). */
const PROGRESS_STATES: {
  label: string;
  value: number | null;
  tone: ProgressBarTone;
  text: string;
}[] = [
  { label: "Running", value: 46, tone: "accent", text: "Building graphics - 46%" },
  { label: "Queued", value: null, tone: "muted", text: "Starts in 6 min" },
  { label: "Paused", value: 62, tone: "muted", text: "Assembling the timeline - 62%" },
  { label: "Stopped", value: 24, tone: "muted", text: "Transcribing - 24%" },
  { label: "Failed", value: 38, tone: "danger", text: "Preparing b-roll - 38%" },
  { label: "Completed", value: 100, tone: "success", text: "Done - 100%" },
];

const LONG_HINDI = "018 Hair Oil जो आपके बालों की Growth बड़ायेगा";
const LONG_LATIN =
  "017 Vitamin C Serum Review - Honest 30 Day Results With Before and After Photos";

export default function Gallery() {
  const platform = usePlatform();
  const [theme, setTheme] = useState<Theme>("system");
  const [segment, setSegment] = useState("all");
  const [model, setModel] = useState("opus");
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState("auto");

  useEffect(() => {
    const html = document.documentElement;
    if (theme === "system") delete html.dataset.theme;
    else html.dataset.theme = theme;
    // The app shell never scrolls the document; the gallery is a long page.
    document.body.style.overflow = "auto";
    html.style.height = "auto";
  }, [theme]);

  const variants: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
  const tones: [StatusTone, string, boolean][] = [
    ["neutral", "Not edited", false],
    ["info", "Queued", false],
    ["accent", "Editing", true],
    ["warning", "Pausing", true],
    ["warning", "Paused", false],
    ["neutral", "Stopping", true],
    ["neutral", "Stopped", false],
    ["danger", "Needs attention", false],
    ["success", "Edited", false],
    ["accent", "Re-editing", true],
    ["accent", "Rendering", true],
    ["success", "Final rendered", false],
  ];

  return (
    <div className="min-h-screen bg-surface text-fg">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-separator bg-surface/90 px-8 py-3 backdrop-blur">
        <h1 className="flex-1 text-lg font-semibold">VidAI primitives</h1>
        <SegmentedControl<Theme>
          aria-label="Theme"
          value={theme}
          onValueChange={setTheme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </header>

      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-8 py-6">
        <Section title="Button">
          {variants.map((variant) => (
            <Row key={variant} label={variant}>
              <Button variant={variant} size="sm">
                Small
              </Button>
              <Button variant={variant} icon={<Play />}>
                Start Editing
              </Button>
              <Button variant={variant} size="lg">
                Large
              </Button>
              <Button variant={variant} loading>
                Saving
              </Button>
              <Button variant={variant} disabled icon={<Pause />}>
                Disabled
              </Button>
            </Row>
          ))}
        </Section>

        <Section title="IconButton">
          <Row>
            <IconButton label="More actions" icon={<Ellipsis />} size="sm" />
            <IconButton label="Refresh" icon={<RefreshCw />} />
            <IconButton label="Find" icon={<FolderSearch />} size="lg" />
            <IconButton label="Copy" icon={<Copy />} variant="secondary" />
            <IconButton label="Delete" icon={<Trash2 />} variant="danger" />
            <IconButton label="Pressed" icon={<Wand2 />} pressed />
            <IconButton label="Loading" icon={<RefreshCw />} loading />
            <IconButton label="Disabled" icon={<Square />} disabled />
          </Row>
        </Section>

        <Section title="Input, Textarea, Field">
          <div className="grid grid-cols-2 gap-4">
            <Input placeholder="Placeholder" aria-label="Plain" />
            <Input
              icon={<Search />}
              placeholder="Search videos"
              aria-label="Search"
              trailing={<Kbd keys={["mod", "F"]} />}
            />
            <Input defaultValue="Glow Naturals" aria-label="Filled" />
            <Input size="sm" defaultValue="Small field" aria-label="Small" />
            <Input invalid defaultValue="Style" aria-label="Invalid" />
            <Input disabled defaultValue="Disabled" aria-label="Disabled" />
            <Field label="Channel name" hint="Renames the folder on disk.">
              {(id, describedBy) => (
                <Input id={id} aria-describedby={describedBy} defaultValue="Kitchen Stories" />
              )}
            </Field>
            <Field label="Channel name" error="A folder named Tech Unboxed already exists.">
              {(id, describedBy) => (
                <Input id={id} aria-describedby={describedBy} invalid defaultValue="Tech Unboxed" />
              )}
            </Field>
            <Field label="Product links" hint="One per line, optional." aside="0 characters">
              {(id) => <Textarea id={id} placeholder="https://" rows={3} />}
            </Field>
            <Field label="Prompt" aside="1,284 characters">
              {(id) => (
                <Textarea
                  id={id}
                  mono
                  rows={3}
                  defaultValue={"MAIN_FOLDER = ...\nEdit the video like this:\n- cut pauses"}
                />
              )}
            </Field>
          </div>
        </Section>

        <Section title="Select and SegmentedControl">
          <Row>
            <Select
              aria-label="Model"
              value={model}
              onValueChange={setModel}
              className="w-[200px]"
              options={[
                { value: "default", label: "Default (Opus 5.5)" },
                {
                  value: "opus",
                  label: "Opus 5.5",
                  description: "Most capable for complex, long edits",
                },
                {
                  value: "sonnet",
                  label: "Sonnet 5.5",
                  description: "Fast and capable for everyday edits",
                },
                {
                  value: "haiku",
                  label: "Haiku 5.5",
                  description: "Fastest, for simple edits",
                  disabled: true,
                },
              ]}
            />
            <Select
              aria-label="Small"
              size="sm"
              value={undefined}
              placeholder="Choose"
              onValueChange={() => {}}
              options={[{ value: "a", label: "A" }]}
            />
            <Select
              aria-label="Disabled"
              disabled
              value="x"
              onValueChange={() => {}}
              options={[{ value: "x", label: "Disabled" }]}
            />
          </Row>
          <Row>
            <SegmentedControl
              aria-label="Filter"
              value={segment}
              onValueChange={setSegment}
              options={[
                { value: "all", label: "All" },
                { value: "toEdit", label: "To edit" },
                { value: "inProgress", label: "In progress" },
                { value: "edited", label: "Edited" },
              ]}
            />
            <SegmentedControl
              aria-label="Video type"
              size="sm"
              value="long"
              onValueChange={() => {}}
              options={[
                { value: "long", label: "Long 16:9" },
                { value: "short", label: "Short 9:16" },
              ]}
            />
            <SegmentedControl
              aria-label="Disabled"
              disabled
              value="a"
              onValueChange={() => {}}
              options={[
                { value: "a", label: "Disabled" },
                { value: "b", label: "Group" },
              ]}
            />
          </Row>
        </Section>

        <Section title="Checkbox">
          <Row>
            <Checkbox checked={checked} onCheckedChange={setChecked}>
              No Sleep
            </Checkbox>
            <Checkbox checked={false} onCheckedChange={setChecked}>
              Unchecked
            </Checkbox>
            <Checkbox checked disabled onCheckedChange={setChecked}>
              Disabled
            </Checkbox>
          </Row>
        </Section>

        <Section title="Tabs">
          <Tabs defaultValue="long">
            <TabsList>
              <TabsTrigger value="long">Long 16:9</TabsTrigger>
              <TabsTrigger value="short">Short 9:16</TabsTrigger>
              <TabsTrigger value="off" disabled>
                Disabled
              </TabsTrigger>
            </TabsList>
            <TabsContent value="long" className="pt-3 text-fg-muted">
              Long prompt and style editors.
            </TabsContent>
            <TabsContent value="short" className="pt-3 text-fg-muted">
              Short prompt and style editors.
            </TabsContent>
          </Tabs>
        </Section>

        <Section title="Badge and StatusPill">
          <Row>
            <Badge variant="outline">Long 16:9</Badge>
            <Badge variant="outline">Short 9:16</Badge>
            <Badge tone="accent">Manual</Badge>
            <Badge tone="warning">Guess</Badge>
            <Badge tone="success">Exists</Badge>
            <Badge tone="danger">Missing</Badge>
            <Badge tone="info">Info</Badge>
          </Row>
          <Row>
            {tones.map(([tone, label, live]) => (
              <StatusPill key={label} tone={tone} label={label} live={live} />
            ))}
          </Row>
        </Section>

        <Section title="Meter, Spinner, Kbd">
          <Row>
            {[20, 72, 94].map((v) => (
              <div key={v} className="flex w-[72px] flex-col gap-1">
                <span className="flex justify-between text-xs text-fg-muted tabular">
                  <span>5h</span>
                  <span>{v}%</span>
                </span>
                <Meter value={v} label="5-hour limit" />
              </div>
            ))}
            <Spinner size={12} />
            <Spinner />
            <Spinner size={20} label="Loading" />
            <Kbd keys={["mod", ","]} />
            <Kbd keys={["mod", "S"]} />
            <Kbd keys={["esc"]} />
          </Row>
        </Section>

        <Section title="ProgressBar">
          <p className="text-sm text-fg-muted">
            Along the bottom of a video row (2 px, the track replaces the row separator) and in the
            activity panel header (6 px).
          </p>
          <div className="overflow-hidden rounded-md border border-border">
            {PROGRESS_STATES.map(({ label, value, tone, text }) => (
              <div
                key={label}
                className="relative flex h-[56px] items-center gap-3 border-b border-transparent px-4"
              >
                <span className="w-28 shrink-0 text-sm font-medium">{label}</span>
                <span className="text-sm text-fg-muted tabular">{text}</span>
                <ProgressBar
                  value={value}
                  tone={tone}
                  label={`Row progress, ${label}`}
                  className="absolute inset-x-0 -bottom-px h-[2px] rounded-none bg-border"
                />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-x-6 gap-y-4">
            {PROGRESS_STATES.map(({ label, value, tone, text }) => (
              <div key={label} className="flex flex-col gap-1.5">
                <span className="flex justify-between gap-3 text-sm">
                  <span className="truncate">{label}</span>
                  <span className="font-medium tabular">{value === null ? "" : `${value}%`}</span>
                </span>
                <ProgressBar
                  value={value}
                  tone={tone}
                  label={`Panel progress, ${label}`}
                  valueText={text}
                  className="h-1.5"
                />
              </div>
            ))}
          </div>
        </Section>

        <Section title="TruncatedText (hover the cut-off names)">
          <div className="flex w-[300px] flex-col gap-1.5 rounded-md border border-border p-2">
            <TruncatedText text={LONG_HINDI} />
            <TruncatedText text={LONG_LATIN} />
            <TruncatedText text="Short name fits" />
          </div>
        </Section>

        <Section title="Tooltip">
          <Row>
            <Tooltip content="Opens the newest project in the Timeline">
              <Button>Hover me</Button>
            </Tooltip>
          </Row>
        </Section>

        <Section title="Dialog, Sheet, ConfirmDialog, DropdownMenu, Toast">
          <Row>
            <Button
              onClick={() => {
                setDialog(true);
              }}
            >
              Open Dialog
            </Button>
            <Button
              onClick={() => {
                setSheet(true);
              }}
            >
              Open Sheet
            </Button>
            <Button
              onClick={() => {
                setConfirm(true);
              }}
            >
              Open Confirm
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button iconRight={<Ellipsis />}>Open Menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem icon={<Play />} shortcut={platform.shortcut(["mod", "O"])}>
                  Open timeline
                </DropdownMenuItem>
                <DropdownMenuItem icon={<FolderSearch />}>Find in library</DropdownMenuItem>
                <DropdownMenuItem disabled>Disabled item</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Video type</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={radio} onValueChange={setRadio}>
                  <DropdownMenuRadioItem value="auto">Auto (Long 16:9)</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="long">Long 16:9</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="short">Short 9:16</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
                  Show finished
                </DropdownMenuCheckboxItem>
                <DropdownMenuItem icon={<Trash2 />} destructive>
                  Remove channel
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => toast.success("Settings saved")}>Toast success</Button>
            <Button
              onClick={() =>
                toast.error(
                  "Could not start editing",
                  "Claude usage limit reached, resets at 4:30 PM",
                )
              }
            >
              Toast error
            </Button>
            <Button
              onClick={() =>
                toast.info("Copied the prompt", undefined, {
                  action: { label: "Undo", onClick: () => {} },
                })
              }
            >
              Toast with action
            </Button>
          </Row>
        </Section>

        <Section title="EmptyState and ScrollArea">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-md border border-border">
              <EmptyState
                icon={<Inbox />}
                title="No videos yet"
                description="Add a folder for each video inside the channel folder."
                action={<Button>Upload Files</Button>}
              />
            </div>
            <div className="rounded-md border border-border">
              <EmptyState
                tone="error"
                icon={<Inbox />}
                title="Could not read the Editing Folder"
                description="Operation not permitted."
                action={<Button>Try Again</Button>}
              />
            </div>
            <ScrollArea
              className="h-[160px] rounded-md border border-border"
              viewportClassName="p-2"
            >
              {Array.from({ length: 30 }, (_, i) => (
                <div key={i} className="py-0.5 font-mono text-xs text-fg-muted">
                  {`#${i + 1} Bash: Render graphics at 1080`}
                </div>
              ))}
            </ScrollArea>
          </div>
        </Section>
      </div>

      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Remove channel"
        description="Glow Naturals is removed from VidAI only."
        size="sm"
        footer={
          <>
            <Button
              onClick={() => {
                setDialog(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDialog(false);
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="text-fg-muted">
          The folder and its videos stay on disk and show up again under Found in Editing Folder.
        </p>
      </Dialog>

      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Start Editing"
        description={LONG_HINDI}
        footer={
          <>
            <Button
              onClick={() => {
                setSheet(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Play />}
              onClick={() => {
                setSheet(false);
              }}
            >
              Start Editing
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-base">
            <dt className="text-fg-muted">Channel</dt>
            <dd>Glow Naturals</dd>
            <dt className="text-fg-muted">Type</dt>
            <dd>Long 16:9 (detected)</dd>
            <dt className="text-fg-muted">Setup</dt>
            <dd>Claude Code</dd>
          </dl>
          <Field label="Product links" hint="One per line, optional.">
            {(id) => <Textarea id={id} rows={3} placeholder="https://" />}
          </Field>
          <Field label="Notes" hint="Optional.">
            {(id) => <Textarea id={id} rows={3} />}
          </Field>
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Stop editing?"
        description="Claude stops now. The working files are kept, and Start Editing begins a new session."
        confirmLabel="Stop Editing"
        tone="danger"
        onConfirm={() => new Promise((resolve) => setTimeout(resolve, 600))}
      />
    </div>
  );
}

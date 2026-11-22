/** The inline field of New Folder: a name, Create and Cancel; a refused name stays shown. */
import { FolderPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";

export interface NewFolderBarProps {
  initialName: string;
  error: string | null;
  busy: boolean;
  createLabel: string;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

export function NewFolderBar({
  initialName,
  error,
  busy,
  createLabel,
  onCreate,
  onCancel,
}: NewFolderBarProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="shrink-0 border-b border-separator bg-subtle/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <FolderPlus className="size-4 shrink-0 text-accent-text" aria-hidden />
        <Input
          ref={inputRef}
          value={name}
          aria-label="Folder name"
          invalid={error !== null}
          wrapperClassName="min-w-0 flex-1"
          onChange={(event) => {
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!busy) onCreate(name);
            }
          }}
        />
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => onCreate(name)}>
          {createLabel}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 pl-6 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

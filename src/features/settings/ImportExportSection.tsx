/**
 * Settings, Import and Export (SPEC sections 14 and 16): share the prompts and styles of your
 * channels as one JSON file. Export downloads it from the page; Import reads a file the person
 * chooses in the page, sends it and says what the server did with it. No native dialogs.
 */
import { FileDown, FileUp } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui";
import { useApi, useAppStoreApi } from "@/lib/appEnv";
import type { ImportResult } from "@/lib/types";
import { describeImport, exportFileName, readDocument } from "./channelsFile";
import { downloadText } from "./download";
import { Callout, Group, Row, SettingsPage } from "./layout";
import { useAction } from "./useAction";

export function ImportExportSection() {
  const api = useApi();
  const store = useAppStoreApi();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const exportChannels = useAction(async () => {
    const document = await api.exportChannels();
    downloadText(exportFileName(new Date()), `${JSON.stringify(document, null, 2)}\n`);
  });

  const importChannels = useAction(async (file: File) => {
    const document = await readDocument(file);
    const done = await api.importChannels({ document });
    setResult(done);
    void store.getState().loadWorkspace();
    void store.getState().refreshLibrary();
  });

  function onChoose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // The same file can be chosen again after a change to it.
    event.target.value = "";
    if (file) void importChannels.run(file);
  }

  const error = exportChannels.error ?? importChannels.error;

  return (
    <SettingsPage>
      <Group
        title="Share with your team"
        description="One file holds each of your channels with its video type, prompts and styles. Folders, videos and passwords are never in it."
      >
        <Row
          label="Export your channels"
          description="Downloads the file, for example to send it to a teammate."
          control={
            <Button
              icon={<FileUp />}
              loading={exportChannels.pending}
              disabled={importChannels.pending}
              onClick={() => {
                importChannels.clearError();
                setResult(null);
                void exportChannels.run();
              }}
            >
              Export
            </Button>
          }
        />
        <Row
          label="Import channels"
          description="Channels with the same name get the video type, prompts and styles from the file. The other channels in it are added, each with a new folder."
          control={
            <>
              <input
                ref={input}
                type="file"
                accept=".json,application/json"
                aria-label="Channels file"
                hidden
                onChange={onChoose}
              />
              <Button
                icon={<FileDown />}
                loading={importChannels.pending}
                disabled={exportChannels.pending}
                onClick={() => {
                  exportChannels.clearError();
                  setResult(null);
                  input.current?.click();
                }}
              >
                Import
              </Button>
            </>
          }
        />
      </Group>
      {error && (
        <Callout
          tone="danger"
          live
          title={
            importChannels.error
              ? "The channels were not imported"
              : "The channels were not exported"
          }
        >
          {error.message}
        </Callout>
      )}
      {result && (
        <Callout tone="success" live title="Channels imported">
          {describeImport(result)}
        </Callout>
      )}
    </SettingsPage>
  );
}

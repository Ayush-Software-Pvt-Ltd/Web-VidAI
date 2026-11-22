/**
 * Admin, Storage (SPEC sections 5 and 6): the largest upload and the preview-copy cache. Where the
 * channels' folders are is not a setting: the admin chooses each channel's folder on the Channels
 * page, anywhere on the server.
 */
import { Button, EmptyState, Spinner } from "@/components/ui";
import { Group, SettingsPage } from "@/features/settings";
import { NumberRow, SaveBar } from "./fields";
import { useSettingsDraft } from "./useSettingsDraft";

const KEYS = ["maxUploadGb", "proxyCacheGb"] as const;
const LABELS = { maxUploadGb: "largest upload", proxyCacheGb: "preview copy cache" } as const;

export function StoragePage() {
  const draft = useSettingsDraft(KEYS, {
    name: "Storage",
    label: (key) => LABELS[key as (typeof KEYS)[number]],
  });
  const { data, status, error } = draft.settings;

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        {status === "error" && error ? (
          <EmptyState
            tone="error"
            title="The settings could not be loaded"
            description={error.message}
            action={<Button onClick={draft.reload}>Try Again</Button>}
          />
        ) : (
          <Spinner label="Loading the settings" />
        )}
      </div>
    );
  }

  return (
    <SettingsPage>
      <Group
        title="Uploads and previews"
        description="Limits on what users send and on what VidAI keeps for faster playback."
      >
        <NumberRow
          draft={draft}
          field="maxUploadGb"
          label="Largest upload"
          description="The biggest single file a user may upload."
          unit="GB"
        />
        <NumberRow
          draft={draft}
          field="proxyCacheGb"
          label="Preview copies"
          description="VidAI keeps small preview copies of videos for the timeline. When they take more than this, the oldest are deleted. They are made again when needed."
          unit="GB"
        />
      </Group>
      <SaveBar draft={draft} />
    </SettingsPage>
  );
}

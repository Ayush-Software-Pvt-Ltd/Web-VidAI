// Admin settings (docs/SPEC.md section 5): adminGetSettings, adminUpdateSettings.

/**
 * @param {import("./index.js").RpcDeps} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function adminSettingsFunctions({ settings, events, hooks }) {
  return [
    {
      name: "adminGetSettings",
      access: "admin",
      handler: () => settings.getAll(),
    },

    {
      name: "adminUpdateSettings",
      access: "admin",
      // The input is the change itself, e.g. `{ maxEdits: 3 }`; unknown keys are refused.
      async handler(input) {
        // The modules may refuse the checked change (a module that cannot allow it right now).
        await hooks?.beforeSettingsChange?.(settings.check(input));
        const all = settings.update(input);
        // Every signed-in page shows the public part (setup, limits); admins' own pages use the answer.
        events.emit({
          event: "settings-changed",
          payload: settings.publicView(),
          userId: null,
          admins: false,
        });
        return all;
      },
    },
  ];
}

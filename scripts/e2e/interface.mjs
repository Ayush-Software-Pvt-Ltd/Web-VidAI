// What the VidAI interface looks like on each platform, as the end-to-end scenarios expect it.
//
// The scenarios never test the platform with `if (windows)` scattered through them: they read
// these few items (the in-page steps get them as `params.platform`, see harness.js), so a change
// of the interface on one platform is a one-line change here. The app's own counterpart is
// src/lib/platform.ts (modifiers, key labels, wording) and SPEC section 11, User interface on
// Windows.

/**
 * @typedef {object} Interface
 * @property {"macos" | "windows"} os
 * @property {"meta" | "ctrl"} modifier the key that goes with the app's shortcuts (Cmd+, Cmd+F,
 *   Cmd+S, Cmd+= ...) on this platform
 * @property {string} modifierLabel how the key hints in the UI name that key
 * @property {string} revealLabel the menu item and button that show a file in the file manager
 * @property {string} quitVerb the verb of the quit confirmation ("Quit VidAI?", "Pause and Quit")
 * @property {"hides" | "quits"} closeWindow what closing the main window does: hides it (the
 *   edits go on, macOS) or quits, through the quit confirmation while edits run (Windows)
 * @property {string} reviewSoftware the review software a new edit uses (settings that name
 *   another one load with this one)
 * @property {"fcp" | "premiere"} reviewSoftwareId
 * @property {"fcpxml" | "xml"} reviewExtension the review project a new edit saves (the fake
 *   Claude Code writes what the real flow does for the review software: FCPXML for Final Cut
 *   Pro, Premiere Pro XML for Premiere Pro)
 * @property {boolean} gitForWindows Settings, System has a Git for Windows row (and onboarding a
 *   Git for Windows step when it is missing)
 * @property {boolean} singleInstance a second launch on the same data folder hands over to the
 *   running app and ends
 * @property {boolean} appMenu the native app menu (VidAI, Edit, View, Window) exists
 * @property {boolean} trafficLights the window has the macOS traffic-light buttons over the top bar
 * @property {boolean} dragRegions the page's top bars drag the window (the overlay title bar)
 */

/** @type {Interface} */
const MACOS = {
  os: "macos",
  modifier: "meta",
  modifierLabel: "⌘",
  revealLabel: "Show in Finder",
  quitVerb: "Quit",
  closeWindow: "hides",
  reviewSoftware: "Final Cut Pro",
  reviewSoftwareId: "fcp",
  reviewExtension: "fcpxml",
  gitForWindows: false,
  singleInstance: false,
  appMenu: true,
  trafficLights: true,
  dragRegions: true,
};

/** @type {Interface} */
const WINDOWS = {
  os: "windows",
  modifier: "ctrl",
  modifierLabel: "Ctrl",
  revealLabel: "Show in File Explorer",
  quitVerb: "Close",
  closeWindow: "quits",
  reviewSoftware: "Premiere Pro",
  reviewSoftwareId: "premiere",
  reviewExtension: "xml",
  gitForWindows: true,
  singleInstance: true,
  appMenu: false,
  trafficLights: false,
  dragRegions: false,
};

/** The interface of the platform the tests run on. */
export function currentInterface() {
  return process.platform === "win32" ? WINDOWS : MACOS;
}

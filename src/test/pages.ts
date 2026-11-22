/** How tests of the whole app tell which page is showing (what a person sees, not test ids). */
import { screen } from "@testing-library/react";

/** The main page: its sidebar lists the channels. */
export const findMainPage = () => screen.findByRole("navigation", { name: "Channels" });
export const queryMainPage = () => screen.queryByRole("navigation", { name: "Channels" });

/** The user's Settings page. */
export const findSettingsPage = () => screen.findByRole("navigation", { name: "Settings" });
export const querySettingsPage = () => screen.queryByRole("navigation", { name: "Settings" });

/** The Admin area. */
export const findAdminPage = () => screen.findByRole("navigation", { name: "Admin" });
export const queryAdminPage = () => screen.queryByRole("navigation", { name: "Admin" });

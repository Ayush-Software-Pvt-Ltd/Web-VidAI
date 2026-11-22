//! Window and app lifecycle (SPEC section 9, "Window, menu and quitting", and section 11,
//! "Window and appearance").
//!
//! - macOS: closing the main window (red button, Cmd+W) only hides it; VidAI keeps running in
//!   the Dock and edits continue. Clicking the Dock icon shows the window again.
//! - Windows: there is no Dock to keep running in, so closing the window (its close button,
//!   Alt+F4, "Close window" on the taskbar) is quitting: it goes through
//!   [`crate::jobs::request_quit`] like Quit on the Mac, which asks to confirm while jobs are busy.
//!   Windows has no menu bar; the web UI handles every shortcut there.
//! - The app menu is a minimal macOS menu: About, Services, Hide, Hide Others, Show All, Quit;
//!   Edit (undo, redo, cut, copy, paste, select all, so text fields work); Window (minimize,
//!   zoom, close, bring all to front). Cmd+, Cmd+F and Cmd+S are deliberately not menu
//!   shortcuts, so they reach the web UI. View has the text size items (Make Text Bigger,
//!   Make Text Smaller, Default Text Size; see [`crate::appearance`]), disabled at the limits.
//! - Quit (menu item and Cmd+Q) does not use AppKit's `terminate:`, which would end the app
//!   without a `RunEvent::ExitRequested`. It calls [`crate::jobs::request_quit`], which asks
//!   the UI to confirm while jobs are busy (`quit-requested`) and exits at once otherwise.

#[cfg(target_os = "macos")]
use tauri::Wry;
use tauri::menu::MenuEvent;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, Window, WindowEvent};

use crate::model::Platform;

/// Label of the main window (`tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

/// Menu id of the app menu's Quit item.
const QUIT_ID: &str = "vidai-quit";
/// Menu ids of the View menu's text size items (also used by the end-to-end hook).
pub const TEXT_BIGGER_ID: &str = "vidai-text-bigger";
pub const TEXT_SMALLER_ID: &str = "vidai-text-smaller";
pub const TEXT_DEFAULT_ID: &str = "vidai-text-default";

/// The View menu's text size items, kept to enable and disable them as the size changes.
#[cfg(target_os = "macos")]
struct TextSizeItems {
    bigger: MenuItem<Wry>,
    smaller: MenuItem<Wry>,
    default: MenuItem<Wry>,
}

/// The app menu (macOS only; other platforms keep no menu bar).
#[cfg(target_os = "macos")]
pub fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let name = app.package_info().name.clone();
    let about = tauri::menu::AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    let quit = MenuItem::with_id(
        app,
        QUIT_ID,
        format!("Quit {name}"),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&format!("About {name}")), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {name}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    // Enabled by the text size once the settings are loaded (`appearance::setup`).
    let bigger = MenuItem::with_id(
        app,
        TEXT_BIGGER_ID,
        "Make Text Bigger",
        true,
        Some("CmdOrCtrl+Equal"),
    )?;
    let smaller = MenuItem::with_id(
        app,
        TEXT_SMALLER_ID,
        "Make Text Smaller",
        true,
        Some("CmdOrCtrl+Minus"),
    )?;
    let default = MenuItem::with_id(
        app,
        TEXT_DEFAULT_ID,
        "Default Text Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let view = Submenu::with_items(app, "View", true, &[&bigger, &smaller, &default])?;
    app.manage(TextSizeItems {
        bigger,
        smaller,
        default,
    });
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    window.set_as_windows_menu_for_nsapp()?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

/// Enables the View menu's text size items that can change `text_size`.
#[cfg(target_os = "macos")]
pub fn update_text_size_items(app: &AppHandle, text_size: u32) {
    if let Some(items) = app.try_state::<TextSizeItems>() {
        set_text_size_items_enabled(&items, text_size);
    }
}

/// Whether the View menu's Make Text Bigger, Make Text Smaller and Default Text Size items are
/// enabled (for the end-to-end hook).
#[cfg(all(target_os = "macos", debug_assertions))]
pub fn text_size_items_enabled(app: &AppHandle) -> Option<[bool; 3]> {
    let items = app.try_state::<TextSizeItems>()?;
    Some([
        items.bigger.is_enabled().ok()?,
        items.smaller.is_enabled().ok()?,
        items.default.is_enabled().ok()?,
    ])
}

#[cfg(target_os = "macos")]
fn set_text_size_items_enabled(items: &TextSizeItems, text_size: u32) {
    use crate::appearance::{TextStep, next_text_size};
    for (item, step) in [
        (&items.bigger, TextStep::Bigger),
        (&items.smaller, TextStep::Smaller),
        (&items.default, TextStep::Default),
    ] {
        if let Err(err) = item.set_enabled(next_text_size(text_size, step) != text_size) {
            eprintln!("vidai: could not update the View menu: {err}");
        }
    }
}

/// Menu event hook.
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    on_menu_item(app, event.id().as_ref());
}

/// Runs the menu item with id `id` (the menu, and the end-to-end hook's `!menu <id>`).
pub fn on_menu_item(app: &AppHandle, id: &str) {
    use crate::appearance::{TextStep, step_text_size};
    let step = match id {
        QUIT_ID => {
            crate::jobs::request_quit(app);
            return;
        }
        TEXT_BIGGER_ID => TextStep::Bigger,
        TEXT_SMALLER_ID => TextStep::Smaller,
        TEXT_DEFAULT_ID => TextStep::Default,
        _ => return,
    };
    if let Err(err) = step_text_size(app, step) {
        eprintln!("vidai: could not change the text size: {err}");
    }
}

/// What closing the main window does on a platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// macOS: the window hides and VidAI keeps running in the Dock.
    Hide,
    /// Windows: closing the window quits, after a confirmation while jobs are busy.
    Quit,
}

/// What closing the main window does on `platform`.
pub const fn close_action(platform: Platform) -> CloseAction {
    match platform {
        Platform::Macos => CloseAction::Hide,
        Platform::Windows => CloseAction::Quit,
    }
}

/// Window event hook: closing the main window hides it (macOS) or quits (Windows), never
/// without asking while jobs are busy. The appearance follows the window too
/// (`appearance::on_window_event`).
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    crate::appearance::on_window_event(window, event);
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        match close_action(Platform::current()) {
            CloseAction::Hide => {
                if let Err(err) = window.hide() {
                    eprintln!("vidai: could not hide the window: {err}");
                }
            }
            CloseAction::Quit => crate::jobs::request_quit(window.app_handle()),
        }
    }
}

/// Run event hook: a click on the Dock icon brings the hidden window back.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        show_main_window(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Shows, unminimizes and focuses the main window (it may be hidden after a close).
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let result = (|| {
        if !window.is_visible()? {
            window.show()?;
        }
        if window.is_minimized()? {
            window.unminimize()?;
        }
        window.set_focus()
    })();
    if let Err(err) = result {
        eprintln!("vidai: could not show the window: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_the_window_hides_on_macos_and_quits_on_windows() {
        assert_eq!(close_action(Platform::Macos), CloseAction::Hide);
        assert_eq!(close_action(Platform::Windows), CloseAction::Quit);
    }
}

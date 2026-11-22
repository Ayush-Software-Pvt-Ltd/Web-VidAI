//! Appearance: the theme and the text size of the UI, applied to the native window
//! (SPEC section 9, Appearance).
//!
//! `Settings.theme` and `Settings.textSize` are the single source of truth. Rust applies them,
//! when the window is created (before it is first shown, so nothing jumps or flashes) and every
//! time they change (`update_appearance`, the View menu):
//!
//! - Theme: the app-wide native appearance (`AppHandle::set_theme`, `None` follows macOS live),
//!   which the title bar, menus, native dialogs and the web content's `prefers-color-scheme`
//!   follow. The window background behind the page gets the theme's window colour, so nothing
//!   white shows before the first paint. The UI also sets `data-theme` on `<html>` from the same
//!   setting (`src/app/appearance.ts`), which is what the browser mock relies on.
//! - Text size: the UI is designed at `BASE_TEXT_SIZE` px with fixed px sizes, so it is scaled as
//!   a whole with the webview's page zoom (`textSize / BASE_TEXT_SIZE`). Layout, hit testing and
//!   measured sizes stay consistent because the page simply sees a smaller viewport in CSS px.
//!   What zoom does not scale is moved here: the traffic lights stay centred in the top bar
//!   ([`crate::platform::appkit`]) and the minimum window size grows with the zoom, up to the
//!   size of the screen.
//! - Windows has a native title bar above the page (SPEC section 11, Window and appearance): its
//!   height and the window borders count against the screen, so the minimum size leaves room for
//!   them, and a window that would not fit on the screen at launch (the default 1240 x 800 on a
//!   1366 x 768 laptop) is made smaller and centred, since Windows, unlike macOS, does not keep
//!   a window on the screen by itself.

use std::sync::Mutex;

use tauri::window::Color;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow, Window, WindowEvent};
use tauri_specta::Event;

use crate::error::AppResult;
use crate::events::SettingsChanged;
use crate::lifecycle::MAIN_WINDOW;
use crate::model::{
    BASE_TEXT_SIZE, DEFAULT_TEXT_SIZE, MAX_TEXT_SIZE, MIN_TEXT_SIZE, Settings, Theme,
};
use crate::store::Store;

/// Height of the web UI's top bar in CSS px (`TOP_BAR_HEIGHT` in `src/app/WindowFrame.tsx`).
pub const TOP_BAR_HEIGHT: f64 = 52.0;
/// Left edge of the close button in points, at every zoom (the buttons do not scale).
pub const TRAFFIC_LIGHT_X: f64 = 18.0;
/// Smallest window the layout is designed for, in CSS px (points at zoom 1).
pub const MIN_LAYOUT_SIZE: (f64, f64) = (980.0, 620.0);
/// `--c-window` of the light and dark themes in `src/styles.css`.
const LIGHT_WINDOW: Color = Color(0xec, 0xec, 0xee, 0xff);
const DARK_WINDOW: Color = Color(0x1e, 0x1e, 0x20, 0xff);

/// Text size steps of the View menu (SPEC section 9, Appearance).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextStep {
    Bigger,
    Smaller,
    Default,
}

/// The page zoom for a text size: the UI is designed at `BASE_TEXT_SIZE`.
pub fn zoom_factor(text_size: u32) -> f64 {
    f64::from(text_size.clamp(MIN_TEXT_SIZE, MAX_TEXT_SIZE)) / f64::from(BASE_TEXT_SIZE)
}

/// The native theme for a theme setting; `None` follows the macOS appearance.
pub fn native_theme(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    }
}

/// The window background for the theme in effect.
pub fn window_color(effective: tauri::Theme) -> Color {
    match effective {
        tauri::Theme::Dark => DARK_WINDOW,
        _ => LIGHT_WINDOW,
    }
}

/// The text size after one View menu step, within range.
pub fn next_text_size(current: u32, step: TextStep) -> u32 {
    match step {
        TextStep::Bigger => current.saturating_add(1),
        TextStep::Smaller => current.saturating_sub(1),
        TextStep::Default => DEFAULT_TEXT_SIZE,
    }
    .clamp(MIN_TEXT_SIZE, MAX_TEXT_SIZE)
}

/// Height in points of the bar the traffic lights are centred in.
pub fn traffic_light_bar_height(zoom: f64) -> f64 {
    TOP_BAR_HEIGHT * zoom
}

/// The minimum window size in points: the smallest layout at this zoom, but never larger than
/// the usable area of the screen (`screen`, when known), so the window always fits on it.
pub fn min_window_size(zoom: f64, screen: Option<LogicalSize<f64>>) -> LogicalSize<f64> {
    let (width, height) = (MIN_LAYOUT_SIZE.0 * zoom, MIN_LAYOUT_SIZE.1 * zoom);
    match screen {
        Some(screen) => LogicalSize::new(width.min(screen.width), height.min(screen.height)),
        None => LogicalSize::new(width, height),
    }
}

/// The window size that respects `min`, or `None` when `current` already does.
pub fn grown_size(current: LogicalSize<f64>, min: LogicalSize<f64>) -> Option<LogicalSize<f64>> {
    // Rounding from physical pixels must not count as too small.
    const SLACK: f64 = 0.5;
    if current.width + SLACK >= min.width && current.height + SLACK >= min.height {
        return None;
    }
    Some(LogicalSize::new(
        current.width.max(min.width),
        current.height.max(min.height),
    ))
}

/// The room the window frame takes around the page: the title bar and the borders on Windows,
/// nothing on macOS, where the transparent title bar is drawn over the page.
pub fn frame_size(outer: LogicalSize<f64>, inner: LogicalSize<f64>) -> LogicalSize<f64> {
    if cfg!(target_os = "macos") {
        return LogicalSize::new(0.0, 0.0);
    }
    LogicalSize::new(
        (outer.width - inner.width).max(0.0),
        (outer.height - inner.height).max(0.0),
    )
}

/// The room for the page on a screen whose usable area is `area`, with a window frame of `frame`.
pub fn content_room(area: LogicalSize<f64>, frame: LogicalSize<f64>) -> LogicalSize<f64> {
    LogicalSize::new(
        (area.width - frame.width).max(0.0),
        (area.height - frame.height).max(0.0),
    )
}

/// The size a window of `current` gets at launch so it fits into `room`, without going below
/// `min`; `None` when it fits already.
pub fn launch_size(
    current: LogicalSize<f64>,
    min: LogicalSize<f64>,
    room: LogicalSize<f64>,
) -> Option<LogicalSize<f64>> {
    // Rounding from physical pixels must not count as too large.
    const SLACK: f64 = 0.5;
    if current.width <= room.width + SLACK && current.height <= room.height + SLACK {
        return None;
    }
    Some(LogicalSize::new(
        current.width.min(room.width).max(min.width),
        current.height.min(room.height).max(min.height),
    ))
}

/// Where a window whose page is `size` and whose frame is `frame` goes so that it is centred in
/// the usable area at `origin` of `area` (the position of its outer frame). Computed from the
/// sizes VidAI sets rather than read back from the window, because a resize of a Windows window
/// takes effect a moment later: centring by the window's own measurement right after `set_size`
/// used the old height and put the bottom of the new window under the taskbar.
pub fn centred_position(
    origin: LogicalPosition<f64>,
    area: LogicalSize<f64>,
    size: LogicalSize<f64>,
    frame: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    LogicalPosition::new(
        origin.x + ((area.width - size.width - frame.width) / 2.0).max(0.0),
        origin.y + ((area.height - size.height - frame.height) / 2.0).max(0.0),
    )
}

/// What was last applied to the window: the zoom (for the minimum size when the window moves to
/// another screen) and the minimum size (so moving the window does not set it again and again).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Applied {
    zoom: f64,
    min: Option<LogicalSize<f64>>,
}

static APPLIED: Mutex<Option<Applied>> = Mutex::new(None);

/// The minimum content size last given to the main window (logical px), if any.
pub fn applied_min_size() -> Option<LogicalSize<f64>> {
    applied().and_then(|a| a.min)
}

fn applied() -> std::sync::MutexGuard<'static, Option<Applied>> {
    APPLIED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Startup hook: applies the saved appearance to the main window, then shows it (the window is
/// created hidden, `visible: false` in `tauri.conf.json`). The window is shown even when
/// applying fails, so a problem here never leaves the app without a window.
pub fn setup(app: &AppHandle) -> AppResult<()> {
    let settings = app.state::<Store>().settings();
    apply(app, &settings);
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW)
        && let Err(err) = fit_on_screen(&window)
    {
        eprintln!("vidai: could not fit the window on the screen: {err}");
    }
    // Cmd+Plus is Make Text Bigger too (a menu item has one shortcut, Cmd+=).
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        crate::platform::appkit::on_command_plus(move || {
            if let Err(err) = step_text_size(&handle, TextStep::Bigger) {
                eprintln!("vidai: could not change the text size: {err}");
            }
        });
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        window.show()?;
    }
    Ok(())
}

/// Applies the theme and the text size (after a change, and at startup). Failures are logged:
/// the setting itself is saved and applies on the next launch at the latest.
pub fn apply(app: &AppHandle, settings: &Settings) {
    app.set_theme(native_theme(settings.theme));
    #[cfg(target_os = "macos")]
    crate::lifecycle::update_text_size_items(app, settings.text_size);
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Err(err) = apply_to_window(&window, settings) {
        eprintln!("vidai: could not apply the appearance: {err}");
    }
}

fn apply_to_window(window: &WebviewWindow, settings: &Settings) -> tauri::Result<()> {
    let effective = match native_theme(settings.theme) {
        Some(theme) => theme,
        None => window.theme()?,
    };
    window.set_background_color(Some(window_color(effective)))?;

    let zoom = zoom_factor(settings.text_size);
    *applied() = Some(Applied { zoom, min: None });
    window.set_zoom(zoom)?;
    #[cfg(target_os = "macos")]
    crate::platform::appkit::set_traffic_lights(
        window,
        crate::platform::appkit::TrafficLights {
            x: TRAFFIC_LIGHT_X,
            bar_height: traffic_light_bar_height(zoom),
        },
    )?;
    fit_min_size(window, zoom)
}

/// The usable area (origin and size) of the window's screen, when known.
fn screen_area(
    window: &WebviewWindow,
) -> tauri::Result<Option<(LogicalPosition<f64>, LogicalSize<f64>)>> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    Ok(monitor.map(|m| {
        let scale = m.scale_factor();
        let rect = m.work_area();
        (
            rect.position.to_logical::<f64>(scale),
            rect.size.to_logical::<f64>(scale),
        )
    }))
}

/// The window frame around the page (see [`frame_size`]).
fn window_frame(window: &WebviewWindow) -> tauri::Result<LogicalSize<f64>> {
    let scale = window.scale_factor()?;
    Ok(frame_size(
        window.outer_size()?.to_logical(scale),
        window.inner_size()?.to_logical(scale),
    ))
}

/// At launch (Windows): makes a window that is larger than its screen smaller and centres it.
#[cfg(not(target_os = "macos"))]
fn fit_on_screen(window: &WebviewWindow) -> tauri::Result<()> {
    let Some((origin, area)) = screen_area(window)? else {
        return Ok(());
    };
    let frame = window_frame(window)?;
    let room = content_room(area, frame);
    let zoom = applied().map_or(1.0, |a| a.zoom);
    let scale = window.scale_factor()?;
    let current = window.inner_size()?.to_logical::<f64>(scale);
    if let Some(size) = launch_size(current, min_window_size(zoom, Some(room)), room) {
        window.set_size(size)?;
        window.set_position(centred_position(origin, area, size, frame))?;
    }
    Ok(())
}

/// Sets the minimum size for `zoom` on the window's current screen and grows the window when it
/// is smaller than that.
fn fit_min_size(window: &WebviewWindow, zoom: f64) -> tauri::Result<()> {
    let area = screen_area(window)?;
    let frame = window_frame(window)?;
    let min = min_window_size(zoom, area.map(|(_, size)| content_room(size, frame)));
    {
        let mut applied = applied();
        let next = Applied {
            zoom,
            min: Some(min),
        };
        if *applied == Some(next) {
            return Ok(());
        }
        *applied = Some(next);
    }
    window.set_min_size(Some(min))?;
    let scale = window.scale_factor()?;
    let current = window.inner_size()?.to_logical::<f64>(scale);
    if let Some(size) = grown_size(current, min) {
        window.set_size(size)?;
        // Growing keeps the top left corner: move the window back onto the screen if needed.
        if let Some((origin, area)) = area {
            let position = window.outer_position()?.to_logical::<f64>(scale);
            let (x, y) = (
                fit_into(position.x, size.width + frame.width, origin.x, area.width),
                fit_into(
                    position.y,
                    size.height + frame.height,
                    origin.y,
                    area.height,
                ),
            );
            if (x, y) != (position.x, position.y) {
                window.set_position(LogicalPosition::new(x, y))?;
            }
        }
    }
    Ok(())
}

/// The start of a span of `length` at `start`, moved so it ends inside `[origin, origin + room]`
/// (and starts inside it when it is longer than that).
pub fn fit_into(start: f64, length: f64, origin: f64, room: f64) -> f64 {
    start.min(origin + room - length).max(origin)
}

/// Window event hook: the window background follows a change of the macOS appearance (with the
/// "System" theme), and the minimum size follows the window to a screen of another size.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    let result = match event {
        WindowEvent::ThemeChanged(theme) => window.set_background_color(Some(window_color(*theme))),
        WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => {
            let zoom = applied().map(|a| a.zoom);
            match (zoom, window.get_webview_window(MAIN_WINDOW)) {
                (Some(zoom), Some(webview_window)) => fit_min_size(&webview_window, zoom),
                _ => Ok(()),
            }
        }
        _ => Ok(()),
    };
    if let Err(err) = result {
        eprintln!("vidai: could not update the window appearance: {err}");
    }
}

/// A View menu text size item: saves the new size, applies it and tells the UI
/// (`settings-changed`), since no command of the UI asked for it.
pub fn step_text_size(app: &AppHandle, step: TextStep) -> AppResult<Settings> {
    let settings = app.state::<Store>().update_settings(|s| {
        s.text_size = next_text_size(s.text_size, step);
        Ok(s.clone())
    })?;
    apply(app, &settings);
    if let Err(err) = SettingsChanged(settings.clone()).emit(app) {
        eprintln!("vidai: could not send settings-changed: {err}");
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn zoom_is_relative_to_the_design_size() {
        assert!(close(zoom_factor(BASE_TEXT_SIZE), 1.0));
        assert!(close(zoom_factor(15), 15.0 / 13.0));
        assert!(close(zoom_factor(MIN_TEXT_SIZE), 11.0 / 13.0));
        assert!(close(zoom_factor(MAX_TEXT_SIZE), 20.0 / 13.0));
        // Out-of-range values (never stored, see store.rs) are clamped, not trusted.
        assert!(close(zoom_factor(0), zoom_factor(MIN_TEXT_SIZE)));
        assert!(close(zoom_factor(99), zoom_factor(MAX_TEXT_SIZE)));
    }

    #[test]
    fn theme_mapping() {
        assert_eq!(native_theme(Theme::System), None);
        assert_eq!(native_theme(Theme::Light), Some(tauri::Theme::Light));
        assert_eq!(native_theme(Theme::Dark), Some(tauri::Theme::Dark));
        assert_eq!(window_color(tauri::Theme::Light), LIGHT_WINDOW);
        assert_eq!(window_color(tauri::Theme::Dark), DARK_WINDOW);
    }

    #[test]
    fn text_steps_stay_in_range() {
        assert_eq!(next_text_size(15, TextStep::Bigger), 16);
        assert_eq!(next_text_size(15, TextStep::Smaller), 14);
        assert_eq!(
            next_text_size(MAX_TEXT_SIZE, TextStep::Bigger),
            MAX_TEXT_SIZE
        );
        assert_eq!(
            next_text_size(MIN_TEXT_SIZE, TextStep::Smaller),
            MIN_TEXT_SIZE
        );
        assert_eq!(
            next_text_size(MAX_TEXT_SIZE, TextStep::Default),
            DEFAULT_TEXT_SIZE
        );
        assert_eq!(
            next_text_size(MIN_TEXT_SIZE, TextStep::Default),
            DEFAULT_TEXT_SIZE
        );
    }

    #[test]
    fn traffic_lights_follow_the_top_bar() {
        assert!(close(traffic_light_bar_height(1.0), 52.0));
        assert!(close(traffic_light_bar_height(zoom_factor(20)), 80.0));
    }

    #[test]
    fn min_size_grows_with_the_zoom_but_fits_the_screen() {
        let laptop = Some(LogicalSize::new(1440.0, 875.0));
        let small = Some(LogicalSize::new(1280.0, 775.0));

        let at = |text_size, screen| min_window_size(zoom_factor(text_size), screen);
        let base = at(BASE_TEXT_SIZE, laptop);
        assert!(close(base.width, 980.0) && close(base.height, 620.0));
        let smaller = at(MIN_TEXT_SIZE, laptop);
        assert!(close(smaller.width, 980.0 * 11.0 / 13.0));

        let default = at(DEFAULT_TEXT_SIZE, laptop);
        assert!(close(default.width, 980.0 * 15.0 / 13.0));
        assert!(close(default.height, 620.0 * 15.0 / 13.0));

        let largest = at(MAX_TEXT_SIZE, laptop);
        assert!(close(largest.width, 1440.0) && close(largest.height, 875.0));
        let largest_small = at(MAX_TEXT_SIZE, small);
        assert!(close(largest_small.width, 1280.0) && close(largest_small.height, 775.0));

        let unknown = at(MAX_TEXT_SIZE, None);
        assert!(close(unknown.width, 980.0 * 20.0 / 13.0));
    }

    #[test]
    fn a_grown_window_stays_on_the_screen() {
        // Room enough: unchanged.
        assert!(close(fit_into(100.0, 1000.0, 0.0, 1440.0), 100.0));
        // Past the right edge: moved left.
        assert!(close(fit_into(600.0, 1000.0, 0.0, 1440.0), 440.0));
        // A screen that starts elsewhere (a second display), and a span longer than it.
        assert!(close(fit_into(2000.0, 1000.0, 1440.0, 1280.0), 1720.0));
        assert!(close(fit_into(1500.0, 1400.0, 1440.0, 1280.0), 1440.0));
    }

    #[test]
    fn the_windows_frame_counts_against_the_screen() {
        let outer = LogicalSize::new(1256.0, 839.0);
        let inner = LogicalSize::new(1240.0, 800.0);
        let frame = frame_size(outer, inner);
        if cfg!(target_os = "macos") {
            assert_eq!(frame, LogicalSize::new(0.0, 0.0));
        } else {
            assert_eq!(frame, LogicalSize::new(16.0, 39.0));
        }
        // A smaller outer size (rounding) never makes a negative frame.
        assert_eq!(frame_size(inner, outer), LogicalSize::new(0.0, 0.0));

        // A 1366 x 768 laptop with a 40 px taskbar, and a Windows frame of 16 x 39.
        let room = content_room(
            LogicalSize::new(1366.0, 728.0),
            LogicalSize::new(16.0, 39.0),
        );
        assert_eq!(room, LogicalSize::new(1350.0, 689.0));
        let min = min_window_size(zoom_factor(DEFAULT_TEXT_SIZE), Some(room));
        assert!(close(min.width, 980.0 * 15.0 / 13.0));
        assert!(close(min.height, 689.0));
    }

    #[test]
    fn a_window_larger_than_the_screen_shrinks_at_launch() {
        let room = LogicalSize::new(1350.0, 689.0);
        let min = LogicalSize::new(1131.0, 689.0);
        // The default window on that laptop: as tall as the room allows.
        assert_eq!(
            launch_size(LogicalSize::new(1240.0, 800.0), min, room),
            Some(LogicalSize::new(1240.0, 689.0))
        );
        // Fits already (also within rounding).
        assert_eq!(
            launch_size(LogicalSize::new(1240.0, 689.4), min, room),
            None
        );
        assert_eq!(
            launch_size(LogicalSize::new(1240.0, 600.0), min, room),
            None
        );
        // Never below the minimum size.
        let big_min = LogicalSize::new(1400.0, 700.0);
        assert_eq!(
            launch_size(LogicalSize::new(1500.0, 800.0), big_min, room),
            Some(LogicalSize::new(1400.0, 700.0))
        );
    }

    #[test]
    fn a_shrunk_window_is_centred_by_the_size_it_gets() {
        // A 1366 x 768 laptop with a 48 pt taskbar; the frame is 16 x 39 (title bar, borders).
        let origin = LogicalPosition::new(0.0, 0.0);
        let area = LogicalSize::new(1366.0, 720.0);
        let frame = LogicalSize::new(16.0, 39.0);
        let size = LogicalSize::new(1240.0, 681.0);
        assert_eq!(
            centred_position(origin, area, size, frame),
            LogicalPosition::new(55.0, 0.0)
        );
        // A second screen to the left and below: relative to its own usable area.
        assert_eq!(
            centred_position(
                LogicalPosition::new(-1920.0, 200.0),
                LogicalSize::new(1920.0, 1040.0),
                LogicalSize::new(1240.0, 800.0),
                frame
            ),
            LogicalPosition::new(-1920.0 + 332.0, 200.0 + 100.5)
        );
        // Never above or left of the area, even when the window is larger.
        assert_eq!(
            centred_position(origin, area, LogicalSize::new(1400.0, 700.0), frame),
            origin
        );
    }

    #[test]
    fn a_window_smaller_than_the_minimum_grows() {
        let min = LogicalSize::new(1131.0, 715.0);
        assert_eq!(grown_size(LogicalSize::new(1240.0, 800.0), min), None);
        assert_eq!(grown_size(LogicalSize::new(1130.6, 714.6), min), None);
        assert_eq!(
            grown_size(LogicalSize::new(980.0, 800.0), min),
            Some(LogicalSize::new(1131.0, 800.0))
        );
        assert_eq!(
            grown_size(LogicalSize::new(980.0, 620.0), min),
            Some(LogicalSize::new(1131.0, 715.0))
        );
    }
}

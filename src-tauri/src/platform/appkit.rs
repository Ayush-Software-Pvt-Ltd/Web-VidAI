//! macOS: the AppKit calls VidAI makes itself, through `objc2` with the `NSWindow` Tauri hands out.
//!
//! - The traffic-light buttons, vertically centred in the web UI's top bar ([`set_traffic_lights`]).
//! - Cmd+Plus (Cmd+Shift+= on a US keyboard) as a second shortcut of Make Text Bigger
//!   ([`on_command_plus`]): a menu item has only one key equivalent, Cmd+=.
//! - For the end-to-end hook only (debug builds): the window on every Space
//!   ([`show_on_every_space`]), a page that keeps running while other windows cover the window
//!   ([`keep_page_visible_when_covered`]), and the measurements and key presses of [`probe`].
//!
//! This is the only module with `unsafe` code (the crate denies it everywhere else), and only the
//! functions that need it allow it: [`on_main_thread`] (turning Tauri's pointer back into an
//! `NSWindow`), the key event monitor, the notification and view calls of the traffic lights,
//! and the WebKit switch of [`keep_page_visible_when_covered`].
//!
//! Traffic lights: the top bar is `TOP_BAR_HEIGHT` CSS px tall, so its height in points follows
//! the page zoom (SPEC section 9, Appearance) and the buttons have to move with it while the
//! window is open. Tauri 2.12 only places them once, when the window is built
//! (`trafficLightPosition`, kept by tao); its runtime has a setter, but `tauri::Window` does not
//! expose it. So VidAI places them itself, the way tao does: the title bar container is made as
//! tall as the top bar and the three buttons are centred in it, starting at `x`.
//!
//! AppKit lays the title bar out again on some changes (every resize, leaving full screen, a
//! title change) and then puts the buttons back at their default place, so the placement is
//! applied again from window notifications, synchronously, before the window is drawn.
//! `tauri.conf.json` must not set `trafficLightPosition`, or tao would move the buttons back to
//! that position on every redraw.

use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
use objc2::{MainThreadMarker, Message};
use objc2_app_kit::{
    NSEvent, NSEventMask, NSEventModifierFlags, NSWindow, NSWindowButton,
    NSWindowCollectionBehavior, NSWindowDidExitFullScreenNotification,
    NSWindowDidResizeNotification, NSWindowStyleMask,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSPoint};
use tauri::{Runtime, WebviewWindow};

/// Where the traffic lights go, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrafficLights {
    /// Left edge of the close button, from the window's left edge.
    pub x: f64,
    /// Height of the bar at the top of the window in which the buttons are vertically centred.
    pub bar_height: f64,
}

/// The window whose buttons are managed, the placement and the notification observers.
struct Managed {
    window: Retained<NSWindow>,
    lights: TrafficLights,
    observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
}

thread_local! {
    /// Only touched on the main thread (AppKit's thread).
    static MANAGED: RefCell<Option<Managed>> = const { RefCell::new(None) };
}

/// Places the traffic lights of `window` and keeps them there from now on. Returns once the
/// change is queued on the main thread.
pub fn set_traffic_lights<R: Runtime>(
    window: &WebviewWindow<R>,
    lights: TrafficLights,
) -> tauri::Result<()> {
    on_main_thread(window, move |ns_window| manage(ns_window.retain(), lights))
}

/// Lets `window` show on every Space, including the Space of another app's full-screen window,
/// so it is never moved out of sight. Only the end-to-end hook uses this (debug builds): a window
/// on another Space is not drawn, and its web content runs no animation frames. It takes effect
/// for an accessory app (one that has no Dock icon); a regular app would have to be activated.
pub fn show_on_every_space<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    on_main_thread(window, |ns_window| {
        ns_window.setCollectionBehavior(
            ns_window.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    })
}

/// Keeps the page of `window` running as a visible page while other windows cover it. Only the
/// end-to-end hook uses this (debug builds).
///
/// WebKit watches the occlusion state of the window: once other windows cover it completely, the
/// page counts as hidden (`document.visibilityState` is `"hidden"`) and WebKit stops its
/// rendering updates, so CSS animations and animation frames stand still. A menu or dialog that
/// closes with an animation then never finishes closing. The test app does not take the focus,
/// so whatever window the person works in can cover it at any time. WKWebView's
/// `_setWindowOcclusionDetectionEnabled:` (WebKit SPI since macOS 10.13, what WebKit's own
/// tests use) turns that watching off; the page then stays visible while the window is on
/// screen. Returns whether WebKit offers the switch.
#[allow(unsafe_code)]
pub fn keep_page_visible_when_covered<R: Runtime>(
    window: &WebviewWindow<R>,
    done: impl FnOnce(bool) + Send + 'static,
) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let Some(view) = NonNull::new(webview.inner().cast::<AnyObject>()) else {
            return done(false);
        };
        // SAFETY: Tauri hands over its WKWebView, which is alive while this closure runs on the
        // main thread.
        let view = unsafe { view.as_ref() };
        let switch = objc2::sel!(_setWindowOcclusionDetectionEnabled:);
        // SAFETY: `respondsToSelector:` is an NSObject method taking a selector, returning BOOL.
        let offered: bool = unsafe { objc2::msg_send![view, respondsToSelector: switch] };
        if offered {
            // SAFETY: the WKWebView answers this selector (checked above); it takes one BOOL and
            // returns nothing.
            unsafe {
                let () = objc2::msg_send![view, _setWindowOcclusionDetectionEnabled: false];
            }
        }
        done(offered);
    })
}

thread_local! {
    /// The Cmd+Plus monitor, kept for the life of the app (main thread only).
    static COMMAND_PLUS: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

/// Calls `handler` instead of delivering a Cmd+Plus key press (Command with the key that types
/// "+", Shift allowed, no Control or Option) anywhere in the app. The View menu's Make Text
/// Bigger item answers Cmd+= only, and the page sees a key only while it has the focus, so this
/// makes Cmd+Plus work like Cmd+= wherever the focus is; the page never gets the key, so one
/// press is always exactly one step. Call once, on the main thread.
#[allow(unsafe_code)]
pub fn on_command_plus(handler: impl Fn() + 'static) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a valid event for the duration of the call.
        let key = unsafe { event.as_ref() };
        if is_command_plus(key) {
            handler();
            return std::ptr::null_mut();
        }
        event.as_ptr()
    });
    // SAFETY: the block returns the event it was given (valid) or null (swallowed).
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    COMMAND_PLUS.with_borrow_mut(|slot| *slot = monitor);
}

fn is_command_plus(event: &NSEvent) -> bool {
    let flags = event.modifierFlags() & NSEventModifierFlags::DeviceIndependentFlagsMask;
    flags.contains(NSEventModifierFlags::Command)
        && !flags.intersects(NSEventModifierFlags::Control | NSEventModifierFlags::Option)
        && event
            .charactersIgnoringModifiers()
            .is_some_and(|keys| keys.to_string() == "+")
}

/// Runs `f` with the `NSWindow` of `window` on the main thread (AppKit's thread). Returns once it
/// is queued.
#[allow(unsafe_code)]
fn on_main_thread<R: Runtime>(
    window: &WebviewWindow<R>,
    f: impl FnOnce(&NSWindow) + Send + 'static,
) -> tauri::Result<()> {
    // A raw pointer is not `Send`; the address is, and it is turned back on the main thread.
    let address = window.ns_window()? as usize;
    window.run_on_main_thread(move || {
        if MainThreadMarker::new().is_none() {
            return;
        }
        let Some(pointer) = NonNull::new(address as *mut NSWindow) else {
            return;
        };
        // SAFETY: Tauri returns the `NSWindow` of a window that is alive while this closure runs
        // (the closure runs on the main thread, where windows are destroyed); whoever keeps it
        // beyond the call retains it.
        f(unsafe { pointer.as_ref() });
    })
}

fn manage(ns_window: Retained<NSWindow>, lights: TrafficLights) {
    let install = MANAGED.with_borrow_mut(|managed| match managed {
        Some(m) if std::ptr::eq(Retained::as_ptr(&m.window), Retained::as_ptr(&ns_window)) => {
            m.lights = lights;
            false
        }
        _ => {
            if let Some(old) = managed.take() {
                remove_observers(&old);
            }
            *managed = Some(Managed {
                window: ns_window.clone(),
                lights,
                observers: Vec::new(),
            });
            true
        }
    });
    if install {
        let observers = add_observers(&ns_window);
        MANAGED.with_borrow_mut(|managed| {
            if let Some(m) = managed {
                m.observers = observers;
            }
        });
    }
    place(&ns_window, lights);
}

/// Places the buttons again after AppKit reset them.
fn reapply() {
    let current =
        MANAGED.with_borrow(|managed| managed.as_ref().map(|m| (m.window.clone(), m.lights)));
    if let Some((window, lights)) = current {
        place(&window, lights);
    }
}

#[allow(unsafe_code)]
fn add_observers(window: &NSWindow) -> Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>> {
    let center = NSNotificationCenter::defaultCenter();
    let block = RcBlock::new(|_: NonNull<NSNotification>| reapply());
    // SAFETY: the names are AppKit's notification name constants, the object is the window that
    // posts them, and with no queue the block runs synchronously on the posting thread, which
    // for window notifications is the main thread (where `MANAGED` lives).
    unsafe {
        [
            NSWindowDidResizeNotification,
            NSWindowDidExitFullScreenNotification,
        ]
        .into_iter()
        .map(|name| {
            let object: &AnyObject = window.as_ref();
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(object),
                None,
                &block,
            )
        })
        .collect()
    }
}

#[allow(unsafe_code)]
fn remove_observers(managed: &Managed) {
    let center = NSNotificationCenter::defaultCenter();
    for observer in &managed.observers {
        let object: &AnyObject = observer.as_ref();
        // SAFETY: each observer is a token returned by `addObserverForName:...` on this center.
        unsafe { center.removeObserver(object) };
    }
}

/// Makes the title bar container `bar_height` tall and centres the three buttons in it.
#[allow(unsafe_code)]
fn place(window: &NSWindow, lights: TrafficLights) {
    // In full screen the buttons live in a separate title bar that slides in; leave it alone.
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let (Some(close), Some(minimize), Some(zoom)) = (
        window.standardWindowButton(NSWindowButton::CloseButton),
        window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        window.standardWindowButton(NSWindowButton::ZoomButton),
    ) else {
        return;
    };
    // SAFETY: the views are retained by the returned `Retained` handles while they are used.
    let Some(title_bar) = (unsafe { close.superview() }) else {
        return;
    };
    let Some(container) = (unsafe { title_bar.superview() }) else {
        return;
    };

    let mut frame = container.frame();
    frame.size.height = lights.bar_height;
    frame.origin.y = window.frame().size.height - lights.bar_height;
    container.setFrame(frame);

    let spacing = minimize.frame().origin.x - close.frame().origin.x;
    // The title bar view fills the container; centring is the same whether or not it is flipped.
    let height = title_bar.frame().size.height;
    for (i, button) in [close, minimize, zoom].iter().enumerate() {
        // Whole or half points: crisp on Retina screens.
        let y = (height - button.frame().size.height).round() / 2.0;
        button.setFrameOrigin(NSPoint::new(lights.x + i as f64 * spacing, y));
    }
}

/// Debug builds only: what the end-to-end hook measures and does through AppKit, so a scenario
/// can check what the page cannot see (where the traffic lights are) and press keys the way a
/// person does (a key event through `NSApplication`, which offers it to the focused view and then
/// to the menu's key equivalents), without needing the Accessibility permission.
#[cfg(debug_assertions)]
pub mod probe {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindowButton,
    };
    use objc2_foundation::{NSPoint, NSString};
    use tauri::{Runtime, WebviewWindow};

    /// The frames of the close, minimize and zoom buttons in points: `[x, y, width, height]` from
    /// the window's top left corner.
    pub fn traffic_lights<R: Runtime>(
        window: &WebviewWindow<R>,
        reply: impl FnOnce(Vec<[f64; 4]>) + Send + 'static,
    ) -> tauri::Result<()> {
        super::on_main_thread(window, move |ns_window| {
            let height = ns_window.frame().size.height;
            let frames = [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ]
            .into_iter()
            .filter_map(|kind| ns_window.standardWindowButton(kind))
            .map(|button| {
                let r = button.convertRect_toView(button.bounds(), None);
                [
                    r.origin.x,
                    height - r.origin.y - r.size.height,
                    r.size.width,
                    r.size.height,
                ]
            })
            .collect();
            reply(frames);
        })
    }

    /// The smallest content size a person can resize the window to, in points.
    pub fn min_content_size<R: Runtime>(
        window: &WebviewWindow<R>,
        reply: impl FnOnce([f64; 2]) + Send + 'static,
    ) -> tauri::Result<()> {
        super::on_main_thread(window, move |ns_window| {
            let size = ns_window.contentMinSize();
            reply([size.width, size.height]);
        })
    }

    /// Presses Cmd (and Shift) with a key, like a person on a US keyboard (the app must be active
    /// for the key to reach the focused view): `characters` is what
    /// the key types with those modifiers, `key_code` the virtual key code.
    pub fn press_key<R: Runtime>(
        window: &WebviewWindow<R>,
        characters: String,
        key_code: u16,
        shift: bool,
    ) -> tauri::Result<()> {
        super::on_main_thread(window, move |ns_window| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let app = NSApplication::sharedApplication(mtm);
            let mut flags = NSEventModifierFlags::Command;
            if shift {
                flags |= NSEventModifierFlags::Shift;
            }
            let text = NSString::from_str(&characters);
            for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
                if let Some(event) = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                    kind,
                    NSPoint::new(0.0, 0.0),
                    flags,
                    0.0,
                    ns_window.windowNumber(),
                    None,
                    &text,
                    &text,
                    false,
                    key_code,
                ) {
                    // Through the event queue, like a key press: monitors and key equivalents
                    // see it as they would see the real one.
                    app.postEvent_atStart(&event, false);
                }
            }
        })
    }

    /// The views a click at `x`, `y` (points from the window's top left) would reach: the class
    /// names from the view AppKit's hit test picks up to the window's frame view.
    #[allow(unsafe_code)]
    pub fn hit_test<R: Runtime>(
        window: &WebviewWindow<R>,
        x: f64,
        y: f64,
        reply: impl FnOnce(Vec<String>) + Send + 'static,
    ) -> tauri::Result<()> {
        super::on_main_thread(window, move |ns_window| {
            let mut chain = Vec::new();
            // SAFETY: the views are retained by the returned `Retained` handles while used.
            let root = ns_window
                .contentView()
                .and_then(|v| unsafe { v.superview() });
            if let Some(root) = root {
                let point = NSPoint::new(x, ns_window.frame().size.height - y);
                let mut view = root.hitTest(point);
                while let Some(v) = view {
                    chain.push(v.class().name().to_string_lossy().into_owned());
                    view = unsafe { v.superview() };
                }
            }
            reply(chain);
        })
    }

    /// The name of the appearance AppKit uses for the whole app (what native panels such as the
    /// folder picker are drawn in), for example "NSAppearanceNameDarkAqua".
    pub fn app_appearance<R: Runtime>(
        window: &WebviewWindow<R>,
        reply: impl FnOnce(String) + Send + 'static,
    ) -> tauri::Result<()> {
        super::on_main_thread(window, move |_| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let app = NSApplication::sharedApplication(mtm);
            reply(app.effectiveAppearance().name().to_string());
        })
    }

    /// Takes the keyboard focus away from the web content: the window itself becomes the first
    /// responder, as when no view in it has the focus.
    pub fn blur<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
        super::on_main_thread(window, |ns_window| {
            ns_window.makeFirstResponder(None);
        })
    }
}

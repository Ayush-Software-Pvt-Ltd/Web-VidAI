//! Opening the address in the browser (SPEC section 12, Server).

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::token::Access;

/// Debug builds only: when set, no browser is started and the address is printed instead (the
/// tests set it, so they never open windows on the developer's screen).
pub const NO_BROWSER_ENV: &str = "VIDAI_WEB_NO_BROWSER";

/// Opens VidAI Web in the default browser: on the first start (unless `--no-open`) and each time
/// a second `vidai-web` asks for it. The address carries the token, so the browser gets its
/// cookie from it. When the browser cannot be opened, the address is printed for the user to
/// open.
pub fn open_browser(app: &AppHandle) {
    let Some(access) = app.try_state::<Access>() else {
        return;
    };
    let address = access.address();
    if cfg!(debug_assertions) && std::env::var_os(NO_BROWSER_ENV).is_some() {
        println!("Open VidAI Web in your browser: {address}");
        return;
    }
    if let Err(err) = app.opener().open_url(&address, None::<&str>) {
        eprintln!(
            "vidai-web: could not open the browser ({err}). Open this address yourself: {address}"
        );
    }
}

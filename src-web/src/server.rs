//! The HTTP server: the router and the listener (SPEC section 12, Server).
//!
//! [`router`] puts the layers (security headers, `Host` and `Origin`, access token) around every
//! route, so no route can be reached without them.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::Arc;

use axum::Router;
use axum::middleware::{from_fn, from_fn_with_state};
use axum::routing::{get, post};
use tauri::AppHandle;

use crate::events::{self, Hub};
use crate::token::Access;
use crate::{asset, auth, fs, headers, invoke, ui};

/// Every route of the server. `app` runs the commands, `hub` feeds the event stream, `access`
/// says which `Host` and token are accepted.
pub fn router(app: AppHandle, hub: Hub, access: Access) -> Router {
    let commands = Router::new()
        .route("/api/invoke/{command}", post(invoke::handler))
        .layer(invoke::body_limit())
        .with_state(app.clone());
    let stream = Router::new()
        .route("/api/events", get(events::handler))
        .with_state(hub);
    let files = Router::new()
        .route("/api/asset", get(asset::handler))
        .route("/api/fs/list", post(fs::list_handler))
        .route("/api/fs/places", post(fs::places_handler))
        .route("/api/fs/create-folder", post(fs::create_folder_handler))
        .with_state(app.clone());
    let routes = Router::new()
        .merge(commands)
        .merge(stream)
        .merge(files)
        .route("/vidai-env.js", get(ui::env_js))
        .fallback(ui::files);
    let access = Arc::new(access);
    // The last layer is the outermost: headers on every answer (also the refusals), then `Host`
    // and `Origin`, then the token.
    routes
        .layer(from_fn_with_state(access.clone(), auth::require_token))
        .layer(from_fn_with_state(access, auth::check_host_and_origin))
        .layer(from_fn(headers::add))
}

/// What went wrong with the port.
#[derive(Debug)]
pub struct BindError {
    pub port: u16,
    pub source: io::Error,
}

impl BindError {
    /// What to tell the user.
    pub fn message(&self) -> String {
        let port = self.port;
        if self.source.kind() == io::ErrorKind::AddrInUse {
            format!(
                "VidAI Web cannot start: port {port} on 127.0.0.1 is already in use (by another \
                 program, or by another copy of vidai-web on another data folder). \
                 Choose another port with --port <n> or VIDAI_WEB_PORT."
            )
        } else {
            format!(
                "VidAI Web cannot start: it could not listen on 127.0.0.1:{port}: {}",
                self.source
            )
        }
    }
}

/// Takes the port on the loopback address (port 0: any free one). The listener is ready for
/// [`serve`], which turns it into an async one.
pub fn bind(port: u16) -> Result<TcpListener, BindError> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .map_err(|source| BindError { port, source })?;
    listener
        .set_nonblocking(true)
        .map_err(|source| BindError { port, source })?;
    Ok(listener)
}

/// Serves `router` on `listener` for the rest of the run (the process ends it).
pub async fn serve(listener: TcpListener, router: Router) -> io::Result<()> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, router).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_port_is_explained() {
        let first = bind(0).unwrap();
        let port = first.local_addr().unwrap().port();
        let err = bind(port).unwrap_err();
        let message = err.message();
        assert!(message.contains(&format!("port {port}")), "{message}");
        assert!(message.contains("already in use"), "{message}");
        assert!(message.contains("--port"), "{message}");
    }

    #[test]
    fn the_loopback_address_only() {
        let listener = bind(0).unwrap();
        assert_eq!(listener.local_addr().unwrap().ip(), Ipv4Addr::LOCALHOST);
    }
}

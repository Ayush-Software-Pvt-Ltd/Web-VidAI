//! `GET /api/events`: every backend event as a Server-Sent Events stream (SPEC section 12).
//!
//! The hub listens to each event of the core (`listen_any`, so no window is involved) and fans the
//! serialized message out to every open stream through a broadcast channel.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderValue, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::{Stream, StreamExt, stream};
use serde_json::{Value, json};
use tauri::{AppHandle, Listener};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use vidai_lib::events::names;

/// The event that opens every stream; its id is new for every server start.
pub const HELLO: &str = "vidai-web://hello";

/// A comment line this often keeps idle connections open.
pub const KEEP_ALIVE: Duration = Duration::from_secs(15);

/// How many events a slow stream may fall behind before it is closed (the page reconnects and
/// reloads, so it never shows stale state).
const BACKLOG: usize = 4096;

/// Every event the core sends, by wire name. A test compares this with `src/lib/bindings.ts`.
pub const NAMES: [&str; 8] = [
    names::LIBRARY_CHANGED,
    names::JOB_UPDATED,
    names::JOB_LOG,
    names::USAGE_UPDATED,
    names::CLAUDE_INFO_UPDATED,
    names::QUIT_REQUESTED,
    names::SETTINGS_CHANGED,
    names::OPENCODE_USAGE_UPDATED,
];

/// The JSON of one stream message.
pub fn message(event: &str, payload: Value) -> String {
    json!({ "event": event, "payload": payload }).to_string()
}

/// The fan-out of backend events to the open streams.
#[derive(Clone)]
pub struct Hub {
    instance: Arc<str>,
    sender: broadcast::Sender<Arc<str>>,
}

impl Hub {
    pub fn new(instance: impl Into<Arc<str>>) -> Self {
        Self {
            instance: instance.into(),
            sender: broadcast::channel(BACKLOG).0,
        }
    }

    /// The id of this server start.
    pub fn instance(&self) -> &str {
        &self.instance
    }

    /// How many pages are connected to the stream now (`usage` refreshes the meters only then).
    pub fn connected(&self) -> usize {
        self.sender.receiver_count()
    }

    /// Passes a message to every open stream (none open is fine).
    pub fn publish(&self, message: String) {
        let _ = self.sender.send(message.into());
    }

    /// Listens to every event of the core on `app` and publishes it.
    pub fn listen(&self, app: &AppHandle) {
        for name in NAMES {
            let hub = self.clone();
            app.listen_any(name, move |event| {
                let payload = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
                hub.publish(message(name, payload));
            });
        }
    }

    /// The stream of one connection: the hello message, then every event published from now on.
    /// It ends when the connection falls too far behind.
    pub fn stream(&self) -> impl Stream<Item = Arc<str>> + Send + use<> {
        // Subscribe before the hello, so nothing between the two is lost.
        let events = BroadcastStream::new(self.sender.subscribe())
            .take_while(|item| {
                let open = !matches!(item, Err(BroadcastStreamRecvError::Lagged(_)));
                async move { open }
            })
            .filter_map(|item| async move { item.ok() });
        let hello = message(HELLO, json!({ "instance": &*self.instance }));
        stream::once(async move { Arc::<str>::from(hello) }).chain(events)
    }
}

/// `GET /api/events`.
pub async fn handler(State(hub): State<Hub>) -> Response {
    let events = hub
        .stream()
        .map(|data| Ok::<_, Infallible>(Event::default().data(&*data)));
    let mut response = Sse::new(events)
        .keep_alive(KeepAlive::new().interval(KEEP_ALIVE).text("keep-alive"))
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// The names of `events` in the generated bindings: `makeEvent<A, B>("name")`.
    fn names_in_bindings(bindings: &str) -> BTreeSet<String> {
        bindings
            .lines()
            .filter_map(|line| {
                line.split_once("makeEvent<")?
                    .1
                    .split_once("(\"")?
                    .1
                    .split_once("\")")
            })
            .map(|(name, _)| name.to_owned())
            .collect()
    }

    #[test]
    fn the_server_forwards_every_event_of_the_bindings() {
        let bindings = include_str!("../../src/lib/bindings.ts");
        let wanted = names_in_bindings(bindings);
        assert!(!wanted.is_empty(), "no event found in src/lib/bindings.ts");
        let ours: BTreeSet<String> = NAMES.iter().map(|n| (*n).to_owned()).collect();
        assert_eq!(ours, wanted);
        assert_eq!(ours.len(), NAMES.len(), "an event is listed twice");
    }

    #[tokio::test]
    async fn a_stream_starts_with_the_hello_and_then_gets_the_events() {
        let hub = Hub::new("abc");
        let mut stream = Box::pin(hub.stream());
        hub.publish(message("library-changed", Value::Null));
        let hello: Value = serde_json::from_str(&stream.next().await.unwrap()).unwrap();
        assert_eq!(
            hello,
            json!({ "event": HELLO, "payload": { "instance": "abc" } })
        );
        let event: Value = serde_json::from_str(&stream.next().await.unwrap()).unwrap();
        assert_eq!(
            event,
            json!({ "event": "library-changed", "payload": null })
        );
    }

    #[tokio::test]
    async fn a_stream_that_falls_too_far_behind_ends() {
        let hub = Hub::new("abc");
        let mut stream = Box::pin(hub.stream());
        for n in 0..=BACKLOG + 1 {
            hub.publish(message("job-log", json!(n)));
        }
        assert!(stream.next().await.is_some(), "the hello comes first");
        assert!(
            stream.next().await.is_none(),
            "then the lag ends the stream"
        );
    }
}

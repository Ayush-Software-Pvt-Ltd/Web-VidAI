//! The start delay timer: one thread that calls back when the delay of a queued job runs out, so
//! the queue is looked at again exactly then (SPEC section 6, "Start delay").
//!
//! The job manager arms it with the next time the delay opens (`queue::Schedule::wake_at`) every
//! time it looks at the queue, and disarms it when nothing waits for the delay. The thread holds
//! only its own small lock while it waits, never the manager lock, and calls the callback without
//! any lock held. The callback is given as a `Weak`-holding closure by the manager, so the timer
//! never keeps the manager alive; [`StartTimer::close`] ends the thread.
//!
//! A wait is at most [`MAX_WAIT`]: the delay is measured on the wall clock (`startsAt` is a wall
//! clock time), while a thread wait runs on a monotonic clock that stands still while the Mac
//! sleeps. Calling back at least every [`MAX_WAIT`] lets the manager check the wall clock again
//! and re-arm, so a sleeping Mac or a changed clock delays a start by at most that much.

use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// Longest single wait before the callback runs and the manager re-arms the timer.
pub const MAX_WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Armed {
    at: Option<Instant>,
    closed: bool,
}

#[derive(Default)]
struct Shared {
    armed: Mutex<Armed>,
    changed: Condvar,
}

/// See the module documentation.
pub struct StartTimer {
    shared: Arc<Shared>,
}

impl StartTimer {
    /// Starts the timer thread. `fire` runs on that thread each time an armed time is reached
    /// (the timer is disarmed first); it returns `false` once its owner is gone, which ends the
    /// thread.
    pub fn start(fire: impl Fn() -> bool + Send + 'static) -> Self {
        let shared = Arc::new(Shared::default());
        let worker = Arc::clone(&shared);
        let spawned = thread::Builder::new()
            .name("vidai-start-delay".into())
            .spawn(move || run(&worker, fire));
        if let Err(err) = spawned {
            eprintln!("vidai: could not start the start delay timer: {err}");
        }
        Self { shared }
    }

    /// Calls back after `after` (at most after [`MAX_WAIT`]), replacing any earlier time; `None`
    /// disarms it.
    pub fn arm(&self, after: Option<Duration>) {
        let mut armed = self.lock();
        armed.at = after.map(|d| Instant::now() + d.min(MAX_WAIT));
        self.shared.changed.notify_all();
    }

    /// Ends the thread.
    pub fn close(&self) {
        let mut armed = self.lock();
        armed.closed = true;
        self.shared.changed.notify_all();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Armed> {
        self.shared
            .armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

fn run(shared: &Shared, fire: impl Fn() -> bool) {
    let lock = || shared.armed.lock().unwrap_or_else(PoisonError::into_inner);
    let mut armed = lock();
    loop {
        if armed.closed {
            return;
        }
        match armed.at {
            None => {
                armed = shared
                    .changed
                    .wait(armed)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            Some(at) => {
                let now = Instant::now();
                if now >= at {
                    armed.at = None;
                    drop(armed);
                    if !fire() {
                        return;
                    }
                    armed = lock();
                } else {
                    armed = shared
                        .changed
                        .wait_timeout(armed, at - now)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn fires_once_per_arming_and_can_be_disarmed() {
        let (tx, rx) = mpsc::channel();
        let timer = StartTimer::start(move || tx.send(Instant::now()).is_ok());
        let armed_at = Instant::now();
        timer.arm(Some(Duration::from_millis(50)));
        let fired = rx.recv_timeout(Duration::from_secs(60)).unwrap();
        assert!(fired >= armed_at + Duration::from_millis(50));
        // Not again until armed again.
        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
        // A later arming replaces an earlier one; disarming cancels it.
        timer.arm(Some(Duration::from_secs(5)));
        timer.arm(None);
        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
        timer.arm(Some(Duration::ZERO));
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        timer.close();
    }

    #[test]
    fn ends_when_the_owner_is_gone() {
        let (tx, rx) = mpsc::channel::<()>();
        let timer = StartTimer::start(move || {
            let _ = tx.send(());
            false
        });
        timer.arm(Some(Duration::ZERO));
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        // The thread ended and dropped the callback with its sender.
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(10)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }
}

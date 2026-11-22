//! The job queue and its launch policy (SPEC section 6, "State machine" and "Start delay").
//!
//! - The queue is first in, first out, at most one entry per video.
//! - At most `Settings::max_concurrent_edits` jobs are in `running`, `pausing` or `stopping` at
//!   once (`model::JobState::holds_slot`). The limit is read again at every decision, so a changed
//!   setting takes effect at once; lowering it never interrupts running jobs.
//! - The start delay (`Settings::start_delay_minutes`): a fresh launch needs, besides a free slot,
//!   either no job holding a slot or the delay passed since the most recent fresh launch. A resume
//!   of work that was already started (Continue Editing) is never held back by the delay and does
//!   not restart its clock.
//!
//! [`schedule`] is the whole policy as one pure function, so the manager only applies its answer.

use std::collections::VecDeque;

use chrono::{DateTime, Duration, Utc};

use crate::model::MAX_CONCURRENT_EDITS_RANGE;

/// How many more jobs may start, given the setting and the number of jobs holding a slot.
pub fn free_slots(max_concurrent_edits: u32, holding: usize) -> usize {
    let max = max_concurrent_edits.clamp(
        *MAX_CONCURRENT_EDITS_RANGE.start(),
        *MAX_CONCURRENT_EDITS_RANGE.end(),
    ) as usize;
    max.saturating_sub(holding)
}

/// A FIFO of waiting jobs, at most one per video.
#[derive(Debug, Clone)]
pub struct JobQueue<T> {
    items: VecDeque<(String, T)>,
}

impl<T> Default for JobQueue<T> {
    fn default() -> Self {
        Self {
            items: VecDeque::new(),
        }
    }
}

impl<T> JobQueue<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends a job for `video_id`, replacing (and moving to the back) any earlier entry of the
    /// same video.
    pub fn push(&mut self, video_id: &str, item: T) {
        self.remove(video_id);
        self.items.push_back((video_id.to_owned(), item));
    }

    /// Takes the entry of `video_id` out of the queue.
    pub fn remove(&mut self, video_id: &str) -> Option<T> {
        let index = self.items.iter().position(|(v, _)| v == video_id)?;
        self.items.remove(index).map(|(_, item)| item)
    }

    pub fn contains(&self, video_id: &str) -> bool {
        self.items.iter().any(|(v, _)| v == video_id)
    }

    /// The entries in queue order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &T)> {
        self.items.iter().map(|(v, item)| (v.as_str(), item))
    }

    /// Takes the entries at the given queue positions (as returned by [`schedule`]), in queue
    /// order. Positions out of range are ignored.
    pub fn take_positions(&mut self, positions: &[usize]) -> Vec<(String, T)> {
        let mut taken = Vec::with_capacity(positions.len());
        let mut kept = VecDeque::with_capacity(self.items.len());
        for (index, entry) in std::mem::take(&mut self.items).into_iter().enumerate() {
            if positions.contains(&index) {
                taken.push(entry);
            } else {
                kept.push_back(entry);
            }
        }
        self.items = kept;
        taken
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Video ids in queue order.
    pub fn video_ids(&self) -> Vec<String> {
        self.items.iter().map(|(v, _)| v.clone()).collect()
    }
}

/// How a queued job would start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartKind {
    /// A launch: new work that will compete for the CPU and GPU. Gated by the start delay, and
    /// restarts its clock.
    Fresh,
    /// Continue Editing of work that was already started (the job has a session). Needs only a
    /// free slot.
    Resume,
}

/// Everything [`schedule`] decides from.
#[derive(Debug, Clone, Copy)]
pub struct Gate {
    /// Free `maxConcurrentEdits` slots ([`free_slots`]).
    pub free_slots: usize,
    /// Jobs holding a slot right now.
    pub holding: usize,
    /// The start delay; zero turns it off.
    pub delay: Duration,
    /// The most recent fresh launch, if any is known.
    pub last_launch: Option<DateTime<Utc>>,
    pub now: DateTime<Utc>,
}

/// What to do with the queue right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    /// Queue positions to launch now, in queue order.
    pub launch: Vec<usize>,
    /// Whether a fresh launch is among them (the delay clock restarts at `now`).
    pub restarts_clock: bool,
    /// Per queue position: the earliest time the start delay lets that job start, set only for
    /// jobs that stay queued because of the delay (`JobView.startsAt`).
    pub starts_at: Vec<Option<DateTime<Utc>>>,
    /// When the delay next opens for a waiting job: the queue must be looked at again then.
    pub wake_at: Option<DateTime<Utc>>,
}

/// The launch policy (see the module documentation).
///
/// Walking the queue in order, while slots are free: a [`StartKind::Resume`] starts; a
/// [`StartKind::Fresh`] job starts when no job holds a slot or the delay has passed since the
/// last fresh launch (each fresh launch restarts that clock). Once a fresh job is held back, the
/// fresh jobs behind it stay behind it (first in, first out); resumes may still pass it.
///
/// `starts_at`: when the first fresh job left waiting is held by the delay (the delay since the
/// last launch has not passed), it gets `last launch + delay`, the next fresh job one more delay,
/// and so on. When the delay has passed and the first waiting job only waits for a slot, none of
/// them is held by the delay and all are `None`.
pub fn schedule(kinds: &[StartKind], gate: Gate) -> Schedule {
    let delay = gate.delay.max(Duration::zero());
    let mut free = gate.free_slots;
    let mut holding = gate.holding;
    let mut last = gate.last_launch;
    let mut launch = Vec::new();
    let mut restarts_clock = false;
    let mut fresh_blocked = false;
    for (index, kind) in kinds.iter().enumerate() {
        if free == 0 {
            break;
        }
        let start = match kind {
            StartKind::Resume => true,
            StartKind::Fresh if fresh_blocked => false,
            StartKind::Fresh => {
                let open =
                    delay.is_zero() || holding == 0 || last.is_none_or(|t| gate.now >= t + delay);
                if open {
                    last = Some(gate.now);
                    restarts_clock = true;
                } else {
                    fresh_blocked = true;
                }
                open
            }
        };
        if start {
            launch.push(index);
            free -= 1;
            holding += 1;
        }
    }

    let mut starts_at = vec![None; kinds.len()];
    let mut wake_at = None;
    // After the launches, the delay holds the waiting fresh jobs only while a job holds a slot
    // and the delay since the last launch has not passed.
    let head = last
        .filter(|_| !delay.is_zero() && holding > 0)
        .map(|t| t + delay)
        .filter(|at| *at > gate.now);
    if let Some(head) = head {
        wake_at = Some(head);
        let waiting = kinds
            .iter()
            .enumerate()
            .filter(|(i, k)| **k == StartKind::Fresh && !launch.contains(i));
        let mut at = head;
        for (index, _) in waiting {
            starts_at[index] = Some(at);
            at += delay;
        }
    }
    Schedule {
        launch,
        restarts_clock,
        starts_at,
        wake_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StartKind::{Fresh, Resume};

    #[test]
    fn free_slots_follow_the_setting() {
        assert_eq!(free_slots(3, 0), 3);
        assert_eq!(free_slots(3, 2), 1);
        assert_eq!(free_slots(3, 3), 0);
        // Lowered while more are running: nothing new starts, nothing is interrupted.
        assert_eq!(free_slots(1, 3), 0);
        // Out-of-range values are clamped to 1..=8.
        assert_eq!(free_slots(0, 0), 1);
        assert_eq!(free_slots(99, 0), 8);
    }

    #[test]
    fn first_in_first_out() {
        let mut q = JobQueue::new();
        q.push("a", 1);
        q.push("b", 2);
        q.push("c", 3);
        assert_eq!(
            q.take_positions(&[0, 1]),
            vec![("a".into(), 1), ("b".into(), 2)]
        );
        assert_eq!(q.video_ids(), vec!["c".to_string()]);
        q.push("d", 4);
        assert_eq!(q.take_positions(&[]), vec![]);
        assert_eq!(
            q.iter().collect::<Vec<_>>(),
            vec![("c", &3), ("d", &4)],
            "iter keeps queue order"
        );
        // Positions are taken in queue order whatever order they are given in.
        assert_eq!(
            q.take_positions(&[1, 0, 7]),
            vec![("c".into(), 3), ("d".into(), 4)]
        );
        assert!(q.is_empty());
    }

    #[test]
    fn one_entry_per_video_and_removal() {
        let mut q = JobQueue::new();
        q.push("a", 1);
        q.push("b", 2);
        q.push("a", 3);
        assert_eq!(q.len(), 2);
        assert_eq!(q.video_ids(), vec!["b".to_string(), "a".to_string()]);
        assert_eq!(q.remove("b"), Some(2));
        assert_eq!(q.remove("b"), None);
        assert!(q.contains("a") && !q.contains("b"));
    }

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-14T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn min(n: i64) -> Duration {
        Duration::minutes(n)
    }

    fn gate(free: usize, holding: usize, delay: i64, last: Option<i64>, now: i64) -> Gate {
        Gate {
            free_slots: free,
            holding,
            delay: min(delay),
            last_launch: last.map(|m| t0() + min(m)),
            now: t0() + min(now),
        }
    }

    fn at(m: i64) -> Option<DateTime<Utc>> {
        Some(t0() + min(m))
    }

    #[test]
    fn without_a_delay_only_slots_count() {
        let s = schedule(&[Fresh, Fresh, Fresh, Fresh], gate(3, 0, 0, Some(0), 0));
        assert_eq!(s.launch, vec![0, 1, 2]);
        assert!(s.restarts_clock);
        assert_eq!(s.starts_at, vec![None; 4]);
        assert_eq!(s.wake_at, None);
        let s = schedule(&[Fresh], gate(0, 3, 0, None, 0));
        assert!(s.launch.is_empty() && !s.restarts_clock);
    }

    #[test]
    fn the_first_launch_is_immediate_the_next_waits_one_delay_each() {
        // Nothing holds a slot: the first starts at once and the others wait, one delay apart.
        let s = schedule(&[Fresh, Fresh, Fresh], gate(3, 0, 10, None, 0));
        assert_eq!(s.launch, vec![0]);
        assert!(s.restarts_clock);
        assert_eq!(s.starts_at, vec![None, at(10), at(20)]);
        assert_eq!(s.wake_at, at(10));
        // Nothing holding a slot opens the gate even right after a launch.
        let s = schedule(&[Fresh], gate(3, 0, 10, Some(-1), 0));
        assert_eq!(s.launch, vec![0]);
    }

    #[test]
    fn the_delay_passes() {
        // 4 minutes after the first launch: still waiting.
        let s = schedule(&[Fresh, Fresh], gate(2, 1, 10, Some(0), 4));
        assert!(s.launch.is_empty() && !s.restarts_clock);
        assert_eq!(s.starts_at, vec![at(10), at(20)]);
        assert_eq!(s.wake_at, at(10));
        // At 10 minutes the head starts and the clock restarts for the next.
        let s = schedule(&[Fresh, Fresh], gate(2, 1, 10, Some(0), 10));
        assert_eq!(s.launch, vec![0]);
        assert_eq!(s.starts_at, vec![None, at(20)]);
        // A launch longer ago than the delay: the new job starts at once.
        let s = schedule(&[Fresh], gate(2, 1, 10, Some(-30), 0));
        assert_eq!(s.launch, vec![0]);
        assert_eq!(s.starts_at, vec![None]);
    }

    #[test]
    fn waiting_only_for_a_slot_is_not_the_delay() {
        // The delay has passed but every slot is busy: no startsAt, nothing to wake up for.
        let s = schedule(&[Fresh, Fresh], gate(0, 3, 10, Some(-30), 0));
        assert!(s.launch.is_empty());
        assert_eq!(s.starts_at, vec![None, None]);
        assert_eq!(s.wake_at, None);
        // Slots busy and the delay not passed: the delay holds them too.
        let s = schedule(&[Fresh, Fresh], gate(0, 3, 10, Some(-4), 0));
        assert_eq!(s.starts_at, vec![at(6), at(16)]);
        assert_eq!(s.wake_at, at(6));
    }

    #[test]
    fn resumes_skip_the_delay_and_keep_the_clock() {
        let s = schedule(&[Fresh, Resume, Fresh], gate(3, 1, 10, Some(-2), 0));
        assert_eq!(s.launch, vec![1]);
        assert!(!s.restarts_clock, "a resume does not restart the clock");
        assert_eq!(s.starts_at, vec![at(8), None, at(18)]);
        // A resume still needs a slot, and keeps queue order with the slots it gets.
        let s = schedule(&[Resume, Resume], gate(1, 2, 10, Some(-2), 0));
        assert_eq!(s.launch, vec![0]);
        // A resume when nothing runs: the clock stays where it was, so a fresh job behind it
        // waits for the rest of the delay.
        let s = schedule(&[Resume, Fresh], gate(3, 0, 10, Some(-2), 0));
        assert_eq!(s.launch, vec![0]);
        assert_eq!(s.starts_at, vec![None, at(8)]);
    }

    #[test]
    fn a_clock_in_the_future_never_waits_longer_than_the_delay_from_it() {
        // The caller clamps a last launch in the future to now; the schedule then waits one delay.
        let s = schedule(&[Fresh], gate(2, 1, 10, Some(0), 0));
        assert_eq!(s.starts_at, vec![at(10)]);
    }
}

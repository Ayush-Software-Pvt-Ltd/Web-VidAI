//! Windows process trees: every child runs without a console window inside a Job Object of its
//! own, created with "kill on job close".
//!
//! - A process in a job cannot leave it (VidAI never allows breakaway), and everything it starts
//!   joins the same job, so the job is always the complete tree: Claude Code, Git Bash, ffmpeg,
//!   Python, Whisper and sub-agents.
//! - The only handle to a job is kept in [`JOBS`]. Closing it ends every process of the job at
//!   once; that is how [`ProcessTree::terminate`] ends a tree, and how [`ChildGroup`] ends a tree
//!   its owner dropped.
//! - When VidAI ends for any reason (quit, crash, killed in Task Manager), Windows closes the
//!   handle and ends every tree. That is the crash watchdog on Windows; [`OrphanWatchdog`] and
//!   [`sweep_registry`] only add the same command-line checked cleanup as on macOS.
//! - Should a job ever not be available (assigning fails), the tree falls back to following the
//!   parent process ids of a process snapshot, like the Unix implementation.
//!
//! Process information (ids, parents, start times, command lines) and ending single processes go
//! through `sysinfo`, job objects through `win32job`; both have safe APIs, so this module needs no
//! `unsafe`.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use win32job::{ExtendedLimitInfo, Job};

use super::{ProcInfo, RegistryEntry, read_registry, write_registry};

/// `CREATE_NO_WINDOW`: the child gets a console without a window, so no console window flashes
/// up for `claude`, Git Bash, ffmpeg or anything they start (they share that hidden console).
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How often [`ProcessTree::terminate`] checks whether everything is gone.
const POLL: Duration = Duration::from_millis(50);
/// How long to wait for processes to disappear after they were ended.
const KILL_CONFIRM: Duration = Duration::from_secs(5);
/// How long processes of a closed job may take to go before they are ended one by one.
const LEFTOVER_AFTER: Duration = Duration::from_millis(500);

/// A job object owned by VidAI, by the process id of the child it was made for.
struct Registered {
    generation: u64,
    job: Job,
}

/// Every live job. Dropping an entry closes the only handle to its job, which ends every process
/// in it. Keyed by the root's process id; the generation tells a reused id apart.
static JOBS: Mutex<BTreeMap<u32, Registered>> = Mutex::new(BTreeMap::new());
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn jobs() -> std::sync::MutexGuard<'static, BTreeMap<u32, Registered>> {
    JOBS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Makes the command start without a console window. On Windows the job object (see
/// [`spawn_in_new_group`]) takes the role of the Unix process group.
pub fn configure_new_group(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Kept by the owner of a child started with [`spawn_in_new_group`]. Dropping it ends whatever is
/// still running of the child's tree (closing its job), so a tree can never outlive its owner.
#[derive(Debug)]
pub struct ChildGroup {
    pid: u32,
    generation: Option<u64>,
}

impl Drop for ChildGroup {
    fn drop(&mut self) {
        if let Some(generation) = self.generation {
            close_job(self.pid, generation);
        }
    }
}

/// Starts `cmd` without a console window and puts the child into a new kill-on-close job object.
///
/// The child is assigned right after it was created, before it had a chance to start anything
/// itself in practice; should assigning ever fail, the tree is followed by parent process ids
/// instead, so the child still runs.
pub fn spawn_in_new_group(cmd: &mut Command) -> io::Result<(Child, ChildGroup)> {
    configure_new_group(cmd);
    let child = cmd.spawn()?;
    let pid = child.id();
    let generation = match new_job().and_then(|job| {
        job.assign_process(child.as_raw_handle() as isize)
            .map(|()| job)
    }) {
        Ok(job) => {
            let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
            // A job left under the same id belongs to a tree whose root is long gone; replacing
            // it ends what is left of that tree.
            jobs().insert(pid, Registered { generation, job });
            Some(generation)
        }
        Err(err) => {
            eprintln!("vidai: could not put process {pid} into a job object: {err}");
            None
        }
    };
    Ok((child, ChildGroup { pid, generation }))
}

fn new_job() -> Result<Job, win32job::JobError> {
    let mut info = ExtendedLimitInfo::new();
    info.limit_kill_on_job_close();
    Job::create_with_limit_info(&info)
}

/// The generation of the job registered for `pid`, if any.
fn job_generation(pid: u32) -> Option<u64> {
    jobs().get(&pid).map(|r| r.generation)
}

/// The processes of the job of `pid` (generation `generation`), or `None` when that job is gone.
fn job_pids(pid: u32, generation: u64) -> Option<BTreeSet<u32>> {
    let jobs = jobs();
    let registered = jobs.get(&pid).filter(|r| r.generation == generation)?;
    match registered.job.query_process_id_list() {
        Ok(list) => Some(list.into_iter().map(|p| p as u32).collect()),
        Err(err) => {
            eprintln!("vidai: could not list the processes of a job: {err}");
            None
        }
    }
}

/// Closes the job of `pid` if it is still generation `generation`, which ends every process in it.
fn close_job(pid: u32, generation: u64) -> bool {
    let mut jobs = jobs();
    if jobs.get(&pid).is_some_and(|r| r.generation == generation) {
        // Dropped here: the last handle closes and Windows ends the processes of the job.
        jobs.remove(&pid);
        true
    } else {
        false
    }
}

// ---------------------------------------------------------------------------------------------
// Process snapshots
// ---------------------------------------------------------------------------------------------

/// A process as seen in one snapshot.
#[derive(Debug, Clone)]
struct Seen {
    parent: Option<u32>,
    start: u64,
}

/// All processes with their parent and start time (cheap: no command lines).
fn system_snapshot() -> io::Result<(System, BTreeMap<u32, Seen>)> {
    let mut sys = System::new().map_err(|e| io::Error::other(e.to_string()))?;
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let seen = sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            (
                pid.as_u32(),
                Seen {
                    parent: p.parent().map(Pid::as_u32),
                    start: p.start_time(),
                },
            )
        })
        .collect();
    Ok((sys, seen))
}

/// The command lines of `pids`, read from `sys` (one extra refresh for just these processes).
fn command_lines(sys: &mut System, pids: &BTreeSet<u32>) -> BTreeMap<u32, String> {
    if pids.is_empty() {
        return BTreeMap::new();
    }
    let list: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&list),
        false,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    pids.iter()
        .filter_map(|pid| {
            let process = sys.process(Pid::from_u32(*pid))?;
            let command = process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let command = if command.is_empty() {
                process.name().to_string_lossy().into_owned()
            } else {
                command
            };
            Some((*pid, command))
        })
        .collect()
}

/// Every process with its command line (expensive; for tests and diagnostics).
pub fn snapshot() -> io::Result<Vec<ProcInfo>> {
    let (mut sys, seen) = system_snapshot()?;
    let pids: BTreeSet<u32> = seen.keys().copied().collect();
    let commands = command_lines(&mut sys, &pids);
    Ok(seen
        .iter()
        .map(|(pid, s)| ProcInfo {
            pid: *pid,
            ppid: s.parent.unwrap_or(0),
            pgid: 0,
            zombie: false,
            command: commands.get(pid).cloned().unwrap_or_default(),
        })
        .collect())
}

/// Ends the given processes (by id) right away. Processes that are already gone are ignored.
fn kill_pids(sys: &System, pids: impl IntoIterator<Item = u32>) {
    for pid in pids {
        if let Some(process) = sys.process(Pid::from_u32(pid)) {
            let _ = process.kill();
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Process trees
// ---------------------------------------------------------------------------------------------

/// A process and everything it started.
#[derive(Debug, Clone)]
pub struct ProcessTree {
    root: u32,
    /// The job holding the tree, while it exists.
    generation: Option<u64>,
    /// Whether the root process itself belongs to the tree (see [`ProcessTree::group`]).
    track_root: bool,
    /// Every process seen in the tree, with its start time (to tell a reused id apart).
    starts: BTreeMap<u32, u64>,
    commands: BTreeMap<u32, String>,
}

impl ProcessTree {
    /// A tree rooted at `root`, a child started with [`spawn_in_new_group`].
    pub fn new(root: u32) -> Self {
        Self {
            root,
            generation: job_generation(root),
            track_root: true,
            starts: BTreeMap::new(),
            commands: BTreeMap::new(),
        }
    }

    /// The tree of a child that may already have exited (its process id may then be reused), so
    /// only what its job holds counts.
    pub fn group(root: u32) -> Self {
        Self {
            track_root: false,
            ..Self::new(root)
        }
    }

    pub fn root(&self) -> u32 {
        self.root
    }

    /// Finds every live process of the tree. Returns the processes alive right now.
    pub fn refresh(&mut self) -> io::Result<Vec<ProcInfo>> {
        let (mut sys, seen) = system_snapshot()?;
        let me = std::process::id();
        let job = self
            .generation
            .and_then(|generation| job_pids(self.root, generation));
        let members: BTreeSet<u32> = match job {
            Some(pids) => pids
                .into_iter()
                .filter(|pid| seen.contains_key(pid))
                .collect(),
            None => self.descendants(&seen),
        };
        let members: BTreeSet<u32> = members.into_iter().filter(|pid| *pid != me).collect();
        let new: BTreeSet<u32> = members
            .iter()
            .copied()
            .filter(|pid| self.starts.get(pid) != Some(&seen[pid].start))
            .collect();
        for (pid, command) in command_lines(&mut sys, &new) {
            self.commands.insert(pid, command);
        }
        let mut out = Vec::new();
        for pid in members {
            let s = &seen[&pid];
            self.starts.insert(pid, s.start);
            out.push(ProcInfo {
                pid,
                ppid: s.parent.unwrap_or(0),
                pgid: 0,
                zombie: false,
                command: self.commands.get(&pid).cloned().unwrap_or_default(),
            });
        }
        Ok(out)
    }

    /// Without a job: the known processes that still run (same start time) and every process
    /// started by one of them, followed by parent process id.
    fn descendants(&self, seen: &BTreeMap<u32, Seen>) -> BTreeSet<u32> {
        let mut members: BTreeSet<u32> = self
            .starts
            .iter()
            .filter(|(pid, start)| seen.get(pid).is_some_and(|s| s.start == **start))
            .map(|(pid, _)| *pid)
            .collect();
        if self.track_root && self.starts.is_empty() && seen.contains_key(&self.root) {
            members.insert(self.root);
        }
        loop {
            let before = members.len();
            for (pid, s) in seen {
                let Some(parent) = s.parent else { continue };
                // A child starts after its parent; anything older only reuses a dead parent's id.
                if members.contains(&parent) && s.start >= seen[&parent].start {
                    members.insert(*pid);
                }
            }
            if members.len() == before {
                return members;
            }
        }
    }

    /// The processes of the tree with their command line, for the registry.
    pub fn entries(&self) -> Vec<RegistryEntry> {
        self.commands
            .iter()
            .map(|(pid, command)| RegistryEntry {
                pid: *pid,
                command: command.clone(),
            })
            .collect()
    }

    /// Ends the whole tree at once and returns `true` when nothing of it is alive any more.
    ///
    /// `grace` is not used on Windows: windowless processes have no polite stop signal, and the
    /// job manager has already asked Claude Code to stop through stdin before it calls this.
    pub fn terminate(&mut self, grace: Duration) -> bool {
        let _ = grace;
        let alive = self.refresh().unwrap_or_default();
        let closed = self
            .generation
            .take()
            .is_some_and(|generation| close_job(self.root, generation));
        // Without a job (assigning it failed) the processes are ended one by one.
        if !closed && let Ok((sys, _)) = system_snapshot() {
            kill_pids(&sys, alive.iter().map(|p| p.pid));
        }
        let started = Instant::now();
        loop {
            match system_snapshot() {
                Ok((sys, seen)) => {
                    let left: Vec<u32> = self
                        .starts
                        .iter()
                        .filter(|(pid, start)| seen.get(pid).is_some_and(|s| s.start == **start))
                        .map(|(pid, _)| *pid)
                        .filter(|pid| *pid != std::process::id())
                        .collect();
                    if left.is_empty() {
                        return true;
                    }
                    // Closing the job ends its processes within moments; anything still there
                    // after that is ended directly.
                    if started.elapsed() >= LEFTOVER_AFTER {
                        kill_pids(&sys, left);
                    }
                }
                Err(_) => return false,
            }
            if started.elapsed() >= KILL_CONFIRM {
                return false;
            }
            thread::sleep(POLL);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Registry sweep and the orphan watchdog
// ---------------------------------------------------------------------------------------------

/// Ends every registered process that still runs with the same command line. Returns how many
/// were found.
fn end_registered(entries: &[RegistryEntry]) -> usize {
    if entries.is_empty() {
        return 0;
    }
    let Ok((mut sys, seen)) = system_snapshot() else {
        return 0;
    };
    let candidates: BTreeSet<u32> = entries
        .iter()
        .map(|e| e.pid)
        .filter(|pid| seen.contains_key(pid) && *pid != std::process::id())
        .collect();
    let commands = command_lines(&mut sys, &candidates);
    let matching: Vec<u32> = commands
        .iter()
        .filter(|(pid, command)| {
            !command.is_empty()
                && entries
                    .iter()
                    .any(|e| e.pid == **pid && e.command == **command)
        })
        .map(|(pid, _)| *pid)
        .collect();
    kill_pids(&sys, matching.iter().copied());
    let deadline = Instant::now() + KILL_CONFIRM;
    while Instant::now() < deadline {
        let Ok((_, now)) = system_snapshot() else {
            break;
        };
        let left = matching
            .iter()
            .filter(|pid| {
                now.get(pid)
                    .is_some_and(|s| seen.get(pid).is_some_and(|before| before.start == s.start))
            })
            .count();
        if left == 0 {
            break;
        }
        thread::sleep(POLL);
    }
    matching.len()
}

/// Startup cleanup: ends every registered process that is still running with the same command
/// line, then empties the registry. Returns how many processes were found. (After a crash Windows
/// has normally ended them already, through the job objects.)
pub fn sweep_registry(path: &Path, grace: Duration) -> usize {
    let _ = grace;
    let found = end_registered(&read_registry(path));
    let _ = write_registry(path, &[]);
    found
}

/// The crash watchdog. On Windows the kill-on-close job objects already end every tree when VidAI
/// goes away, even after a crash, so this only keeps the API of the Unix watchdog: triggering it
/// ends the processes listed in the registry.
pub struct OrphanWatchdog {
    registry: PathBuf,
}

impl OrphanWatchdog {
    /// "Starts" the watchdog for the registry at `registry`. Never fails.
    pub fn start(registry: PathBuf) -> io::Result<Self> {
        Ok(Self { registry })
    }

    /// Runs the cleanup now (as if VidAI had exited). Always finishes in time.
    pub fn trigger_and_wait(self, timeout: Duration) -> bool {
        let _ = timeout;
        end_registered(&read_registry(&self.registry));
        true
    }

    /// Whether the watchdog is still waiting (always, until it is triggered).
    pub fn is_running(&mut self) -> bool {
        true
    }

    /// Checks that the watchdog is alive (it always is on Windows).
    pub fn ping(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// A PowerShell that starts a nested PowerShell which starts `ping`, so the tree has three
    /// levels (all native Windows processes, no Git Bash needed).
    fn tree_command() -> Command {
        let mut cmd = Command::new(powershell());
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process -NoNewWindow -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','ping -n 300 127.0.0.1 > $null'; ping -n 300 127.0.0.1 > $null",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        cmd
    }

    fn powershell() -> PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    }

    fn alive_pids(pids: &[u32]) -> Vec<u32> {
        let (_, seen) = system_snapshot().unwrap();
        pids.iter()
            .copied()
            .filter(|p| seen.contains_key(p))
            .collect()
    }

    fn wait_for_members(tree: &mut ProcessTree, count: usize) -> Vec<ProcInfo> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let members = tree.refresh().unwrap();
            if members.len() >= count || Instant::now() >= deadline {
                return members;
            }
            thread::sleep(POLL);
        }
    }

    #[test]
    fn terminate_ends_the_whole_job_tree() {
        let (mut child, group) = spawn_in_new_group(&mut tree_command()).unwrap();
        let mut tree = ProcessTree::new(child.id());
        assert!(tree.generation.is_some(), "the child is in a job");
        // powershell, nested powershell, two pings (and possibly conhost helpers).
        let members = wait_for_members(&mut tree, 4);
        assert!(members.len() >= 4, "{members:?}");
        assert!(members.iter().any(|p| p.command.contains("ping")));
        let pids: Vec<u32> = members.iter().map(|p| p.pid).collect();
        assert!(!tree.entries().is_empty());

        assert!(tree.terminate(Duration::from_millis(300)));
        assert!(alive_pids(&pids).is_empty(), "{:?}", alive_pids(&pids));
        // The root is gone too (its exit code is up to Windows).
        child.wait().unwrap();
        drop(group);
    }

    #[test]
    fn dropping_the_group_ends_the_tree() {
        let (mut child, group) = spawn_in_new_group(&mut tree_command()).unwrap();
        let mut tree = ProcessTree::new(child.id());
        let members = wait_for_members(&mut tree, 4);
        let pids: Vec<u32> = members.iter().map(|p| p.pid).collect();
        drop(group);
        let deadline = Instant::now() + KILL_CONFIRM;
        while !alive_pids(&pids).is_empty() && Instant::now() < deadline {
            thread::sleep(POLL);
        }
        assert!(alive_pids(&pids).is_empty());
        let _ = child.wait();
        // The tree notices the job is gone and finds nothing alive.
        assert!(tree.terminate(Duration::ZERO));
    }

    #[test]
    fn kill_now_ends_a_helper_and_its_children() {
        let (mut child, _group) = spawn_in_new_group(&mut tree_command()).unwrap();
        let mut tree = ProcessTree::new(child.id());
        let pids: Vec<u32> = wait_for_members(&mut tree, 4)
            .iter()
            .map(|p| p.pid)
            .collect();
        super::super::kill_now(&mut child);
        let deadline = Instant::now() + KILL_CONFIRM;
        while !alive_pids(&pids).is_empty() && Instant::now() < deadline {
            thread::sleep(POLL);
        }
        assert!(alive_pids(&pids).is_empty());
    }

    #[test]
    fn watchdog_and_sweep_end_only_matching_processes() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = dir.path().join("processes.tsv");
        let spawn_waiter = || {
            // Not in a job of ours, so only the registry can end it.
            let mut cmd = Command::new(powershell());
            cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 37"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_new_group(&mut cmd);
            cmd.spawn().unwrap()
        };
        let command_of = |pid: u32| {
            let (mut sys, _) = system_snapshot().unwrap();
            command_lines(&mut sys, &BTreeSet::from([pid]))
                .remove(&pid)
                .unwrap()
        };

        let mut a = spawn_waiter();
        write_registry(
            &registry,
            &[RegistryEntry {
                pid: a.id(),
                command: command_of(a.id()),
            }],
        )
        .unwrap();
        let mut watchdog = OrphanWatchdog::start(registry.clone()).unwrap();
        assert!(watchdog.is_running());
        watchdog.ping().unwrap();
        assert!(watchdog.trigger_and_wait(Duration::from_secs(10)));
        assert!(!a.wait().unwrap().success());

        let mut b = spawn_waiter();
        let mut c = spawn_waiter();
        write_registry(
            &registry,
            &[
                RegistryEntry {
                    pid: b.id(),
                    command: command_of(b.id()),
                },
                RegistryEntry {
                    pid: c.id(),
                    command: "something else".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(sweep_registry(&registry, Duration::from_millis(500)), 1);
        assert!(!b.wait().unwrap().success());
        assert_eq!(
            c.try_wait().unwrap(),
            None,
            "unmatched process is left alone"
        );
        c.kill().unwrap();
        c.wait().unwrap();
        assert!(read_registry(&registry).is_empty());
    }
}

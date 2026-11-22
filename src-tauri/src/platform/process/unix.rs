//! Unix (macOS) process trees: children in their own process group, ending a whole tree with
//! SIGTERM, then SIGKILL after a grace period.
//!
//! Claude Code runs each Bash command in a process group of its own, so killing Claude's group
//! alone would leave ffmpeg, Python or Whisper running. [`ProcessTree`] therefore remembers every
//! descendant of the Claude process and every process group they lead, and keeps finding them
//! after Claude itself exits and its children are re-parented.
//!
//! Crash safety: [`OrphanWatchdog`] is a tiny `sh` process that blocks on a pipe from VidAI. When
//! VidAI ends for any reason (quit, crash, force quit) the pipe closes and the watchdog ends
//! everything listed in the registry file that the job manager keeps current
//! ([`write_registry`]). [`sweep_registry`] does the same at the next startup, and only touches
//! processes whose command line still matches what was recorded (protection against reused
//! process ids).
//!
//! Process information comes from `/bin/ps` and signals are sent with `/bin/kill`, which keeps this
//! module free of `unsafe` and of extra dependencies.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{ProcInfo, RegistryEntry, read_registry, write_registry};

const PS: &str = "/bin/ps";
const KILL: &str = "/bin/kill";
/// How often [`ProcessTree::terminate`] checks whether everything is gone.
const POLL: Duration = Duration::from_millis(50);
/// How long to wait for processes to disappear after SIGKILL.
const KILL_CONFIRM: Duration = Duration::from_secs(2);

/// Makes the command start in a new process group led by the child itself.
pub fn configure_new_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

/// Kept by the owner of a child started with [`spawn_in_new_group`]. On Unix the process group
/// needs nothing more, so this holds nothing.
#[derive(Debug)]
pub struct ChildGroup(());

/// Starts `cmd` in a new process group led by the child itself (see [`configure_new_group`]).
pub fn spawn_in_new_group(cmd: &mut Command) -> io::Result<(Child, ChildGroup)> {
    configure_new_group(cmd);
    Ok((cmd.spawn()?, ChildGroup(())))
}

/// Every process of the current user and others that `ps` can see.
pub fn snapshot() -> io::Result<Vec<ProcInfo>> {
    let out = Command::new(PS)
        .args(["-axo", "pid=,ppid=,pgid=,stat=,command="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    if !out.status.success() {
        return Err(io::Error::other(format!("ps failed: {}", out.status)));
    }
    Ok(parse_ps(&String::from_utf8_lossy(&out.stdout)))
}

fn parse_ps(text: &str) -> Vec<ProcInfo> {
    text.lines()
        .filter_map(|line| {
            let mut rest = line.trim_start();
            let mut fields = [0u32; 3];
            for field in &mut fields {
                let end = rest.find(char::is_whitespace)?;
                *field = rest[..end].parse().ok()?;
                rest = rest[end..].trim_start();
            }
            let (stat, command) = match rest.find(char::is_whitespace) {
                Some(end) => (&rest[..end], rest[end..].trim()),
                None => (rest, ""),
            };
            Some(ProcInfo {
                pid: fields[0],
                ppid: fields[1],
                pgid: fields[2],
                zombie: stat.starts_with('Z'),
                command: command.to_owned(),
            })
        })
        .collect()
}

/// The CPU time each of `pids` has used so far, in milliseconds (`ps` `time`); processes that
/// are gone or cannot be read are left out.
pub fn cpu_times(pids: &[u32]) -> BTreeMap<u32, u64> {
    if pids.is_empty() {
        return BTreeMap::new();
    }
    let list: Vec<String> = pids.iter().map(u32::to_string).collect();
    let Ok(out) = Command::new(PS)
        .args(["-o", "pid=,time=", "-p", &list.join(",")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return BTreeMap::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (pid, time) = line.trim().split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, parse_cpu_time(time.trim())?))
        })
        .collect()
}

/// `ps` CPU time as milliseconds: `0:01.50`, `12:34.56`, `1:02:03`, `2-03:04:05`.
fn parse_cpu_time(text: &str) -> Option<u64> {
    let (days, rest) = match text.split_once('-') {
        Some((d, rest)) => (d.parse::<u64>().ok()?, rest),
        None => (0, text),
    };
    let mut seconds = 0.0f64;
    for part in rest.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(((days * 86_400) as f64 * 1000.0 + seconds * 1000.0).round() as u64)
}

/// Sends `signal` (for example "TERM") to every target; group targets are negative numbers.
/// Targets that no longer exist are ignored.
fn send_signal(signal: &str, pids: &BTreeSet<u32>, groups: &BTreeSet<u32>) {
    if pids.is_empty() && groups.is_empty() {
        return;
    }
    let mut cmd = Command::new(KILL);
    cmd.args(["-s", signal, "--"]);
    cmd.args(pids.iter().map(u32::to_string));
    cmd.args(groups.iter().map(|g| format!("-{g}")));
    let _ = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// The process group of VidAI itself, which must never be signalled.
fn own_group(procs: &[ProcInfo]) -> Option<u32> {
    let me = std::process::id();
    procs.iter().find(|p| p.pid == me).map(|p| p.pgid)
}

/// A process and everything it started, followed across re-parenting.
#[derive(Debug, Clone)]
pub struct ProcessTree {
    root: u32,
    pids: BTreeSet<u32>,
    groups: BTreeSet<u32>,
    commands: BTreeMap<u32, String>,
}

impl ProcessTree {
    /// A tree rooted at `root` (a child spawned with [`configure_new_group`], so `root` also
    /// leads its own group).
    pub fn new(root: u32) -> Self {
        Self {
            root,
            pids: BTreeSet::from([root]),
            groups: BTreeSet::from([root]),
            commands: BTreeMap::new(),
        }
    }

    /// A tree of the members of process group `pgid` and their descendants, without tracking the
    /// group leader's pid itself (use it when the leader may already be reaped, so a reused pid
    /// is never signalled).
    pub fn group(pgid: u32) -> Self {
        Self {
            root: pgid,
            pids: BTreeSet::new(),
            groups: BTreeSet::from([pgid]),
            commands: BTreeMap::new(),
        }
    }

    pub fn root(&self) -> u32 {
        self.root
    }

    /// Adds every live descendant of a known process and every member of a known group.
    /// Returns the processes of the tree that are alive right now.
    pub fn refresh(&mut self) -> io::Result<Vec<ProcInfo>> {
        let procs = snapshot()?;
        Ok(self.absorb(&procs))
    }

    fn absorb(&mut self, procs: &[ProcInfo]) -> Vec<ProcInfo> {
        let forbidden_group = own_group(procs);
        let me = std::process::id();
        let alive: BTreeMap<u32, &ProcInfo> = procs
            .iter()
            .filter(|p| !p.zombie && p.pid > 1 && p.pid != me)
            .map(|p| (p.pid, p))
            .collect();
        // Members of known groups, then descendants of anything known, until nothing changes.
        let mut members: BTreeSet<u32> = alive
            .values()
            .filter(|p| self.groups.contains(&p.pgid) || self.pids.contains(&p.pid))
            .map(|p| p.pid)
            .collect();
        loop {
            let before = members.len();
            for p in alive.values() {
                if members.contains(&p.ppid) {
                    members.insert(p.pid);
                }
            }
            if members.len() == before {
                break;
            }
        }
        let mut out = Vec::new();
        for pid in members {
            let p = alive[&pid];
            self.pids.insert(p.pid);
            if p.pgid > 1 && Some(p.pgid) != forbidden_group {
                self.groups.insert(p.pgid);
            }
            self.commands.insert(p.pid, p.command.clone());
            out.push(p.clone());
        }
        if let Some(group) = forbidden_group {
            self.groups.remove(&group);
        }
        out
    }

    /// The live processes of the tree with their pgid and command line, for the registry.
    pub fn entries(&self) -> Vec<RegistryEntry> {
        self.commands
            .iter()
            .map(|(pid, command)| RegistryEntry {
                pid: *pid,
                command: command.clone(),
            })
            .collect()
    }

    /// Ends the whole tree: SIGTERM to every process and group, SIGKILL to what is left after
    /// `grace`. Returns `true` when nothing of the tree is alive any more.
    pub fn terminate(&mut self, grace: Duration) -> bool {
        let Ok(mut alive) = self.refresh() else {
            // Without `ps` we can still signal what we know.
            send_signal("TERM", &self.pids, &self.groups);
            thread::sleep(grace);
            send_signal("KILL", &self.pids, &self.groups);
            return false;
        };
        if alive.is_empty() {
            return true;
        }
        send_signal("TERM", &live_pids(&alive), &self.groups);
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            thread::sleep(POLL);
            match self.refresh() {
                Ok(now) if now.is_empty() => return true,
                Ok(now) => {
                    // Something new may have started in the meantime.
                    let fresh: BTreeSet<u32> = now
                        .iter()
                        .map(|p| p.pid)
                        .filter(|pid| !alive.iter().any(|p| p.pid == *pid))
                        .collect();
                    if !fresh.is_empty() {
                        send_signal("TERM", &fresh, &BTreeSet::new());
                    }
                    alive = now;
                }
                Err(_) => break,
            }
        }
        let deadline = Instant::now() + KILL_CONFIRM;
        loop {
            send_signal("KILL", &live_pids(&alive), &self.groups);
            thread::sleep(POLL);
            match self.refresh() {
                Ok(now) if now.is_empty() => return true,
                Ok(now) => alive = now,
                Err(_) => return false,
            }
            if Instant::now() >= deadline {
                return false;
            }
        }
    }
}

fn live_pids(procs: &[ProcInfo]) -> BTreeSet<u32> {
    procs.iter().map(|p| p.pid).collect()
}

// ---------------------------------------------------------------------------------------------
// Registry of running trees and the orphan watchdog
// ---------------------------------------------------------------------------------------------

/// Startup cleanup: ends every registered process that is still running with the same command
/// line (and its process group when it leads one), then empties the registry. Returns how many
/// processes were found.
pub fn sweep_registry(path: &Path, grace: Duration) -> usize {
    let entries = read_registry(path);
    if entries.is_empty() {
        return 0;
    }
    let Ok(procs) = snapshot() else {
        return 0;
    };
    let matching: Vec<&ProcInfo> = procs
        .iter()
        .filter(|p| !p.zombie)
        .filter(|p| {
            entries
                .iter()
                .any(|e| e.pid == p.pid && e.command == p.command && !p.command.is_empty())
        })
        .collect();
    let found = matching.len();
    if found > 0 {
        let mut tree = ProcessTree {
            root: matching[0].pid,
            pids: matching.iter().map(|p| p.pid).collect(),
            groups: matching
                .iter()
                .filter(|p| p.pgid == p.pid)
                .map(|p| p.pgid)
                .collect(),
            commands: BTreeMap::new(),
        };
        tree.terminate(grace);
    }
    let _ = write_registry(path, &[]);
    found
}

/// A watchdog process that ends every process in the registry file when VidAI goes away.
///
/// The watchdog reads its stdin, a pipe whose write end only VidAI holds (Rust opens pipes
/// close-on-exec, so no other child inherits it). Any exit of VidAI closes the pipe; the
/// watchdog then sends SIGTERM to the registered processes and their groups, and SIGKILL three
/// seconds later. On a clean shutdown the registry is empty by then and nothing happens.
pub struct OrphanWatchdog {
    child: Child,
    stdin: Option<ChildStdin>,
}

const WATCHDOG_SCRIPT: &str = r#"
while IFS= read -r _line; do :; done
f="$1"
[ -s "$f" ] || exit 0
pids=$(cut -f1 "$f" | tr '\n' ' ')
groups=""
for p in $pids; do
  g=$(/bin/ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')
  if [ "$g" = "$p" ]; then groups="$groups -$g"; fi
done
/bin/kill -s TERM -- $pids $groups 2>/dev/null
sleep 3
/bin/kill -s KILL -- $pids $groups 2>/dev/null
exit 0
"#;

impl OrphanWatchdog {
    /// Starts the watchdog for the registry at `registry`.
    pub fn start(registry: PathBuf) -> io::Result<Self> {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(WATCHDOG_SCRIPT)
            .arg("vidai-watchdog")
            .arg(registry)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Its own group, so a signal to VidAI's group (Ctrl+C in a terminal) leaves it alive.
        configure_new_group(&mut cmd);
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();
        Ok(Self { child, stdin })
    }

    /// Lets the watchdog run its cleanup now (as if VidAI had exited) and waits for it.
    pub fn trigger_and_wait(mut self, timeout: Duration) -> bool {
        self.stdin.take();
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return true;
            }
            thread::sleep(POLL);
        }
        false
    }

    /// Whether the watchdog is still waiting.
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Keeps the pipe open (writing nothing); used by tests to check the watchdog is alive.
    pub fn ping(&mut self) -> io::Result<()> {
        match self.stdin.as_mut() {
            Some(stdin) => stdin.flush(),
            None => Err(io::Error::other("watchdog already triggered")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_cpu_time_of_ps() {
        assert_eq!(parse_cpu_time("0:00.00"), Some(0));
        assert_eq!(parse_cpu_time("0:01.50"), Some(1500));
        assert_eq!(parse_cpu_time("12:34.56"), Some(754_560));
        assert_eq!(parse_cpu_time("1:02:03"), Some(3_723_000));
        assert_eq!(parse_cpu_time("2-03:04:05"), Some(183_845_000));
        assert_eq!(parse_cpu_time("x"), None);
        // Our own process can be read.
        let times = cpu_times(&[std::process::id()]);
        assert!(times.contains_key(&std::process::id()));
    }

    #[test]
    fn parses_ps_output() {
        let text = "  101     1   101 Ss   /usr/bin/claude -p --verbose\n\
                    \x20 202   101   202 S+   sleep 300\n\
                    \x20 303   101   101 Z    (node)\n\
                    garbage line\n";
        let procs = parse_ps(text);
        assert_eq!(procs.len(), 3);
        assert_eq!(
            procs[0],
            ProcInfo {
                pid: 101,
                ppid: 1,
                pgid: 101,
                zombie: false,
                command: "/usr/bin/claude -p --verbose".into()
            }
        );
        assert!(procs[2].zombie);
    }

    #[test]
    fn absorbs_descendants_and_groups_across_reparenting() {
        let me = std::process::id();
        let p = |pid, ppid, pgid| ProcInfo {
            pid,
            ppid,
            pgid,
            zombie: false,
            command: format!("cmd{pid}"),
        };
        let mut tree = ProcessTree::new(500);
        let procs = vec![
            p(me, 1, 900),
            p(500, me, 500),
            p(501, 500, 501), // bash in its own group
            p(502, 501, 501), // ffmpeg under it
            p(503, 500, 900), // something in VidAI's own group: tracked by pid, group never
            p(600, 1, 600),   // unrelated
        ];
        let alive = tree.absorb(&procs);
        assert_eq!(live_pids(&alive), BTreeSet::from([500, 501, 502, 503]));
        assert!(!tree.groups.contains(&900));
        // Claude exits, ffmpeg is re-parented to launchd but stays in a known group.
        let procs = vec![p(me, 1, 900), p(502, 1, 501), p(600, 1, 600)];
        assert_eq!(live_pids(&tree.absorb(&procs)), BTreeSet::from([502]));
    }

    #[test]
    fn terminate_ends_a_real_tree_including_other_groups() {
        // A shell in its own group starting a child in yet another group that ignores SIGTERM.
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("set -m; sh -c 'trap \"\" TERM; while :; do sleep 1; done' & sleep 30 & wait");
        configure_new_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let root = child.id();
        let reaper = thread::spawn(move || child.wait());
        let mut tree = ProcessTree::new(root);
        // Wait until both grandchildren exist.
        let deadline = Instant::now() + Duration::from_secs(5);
        while tree.refresh().unwrap().len() < 4 && Instant::now() < deadline {
            thread::sleep(POLL);
        }
        let members = tree.refresh().unwrap();
        assert!(members.len() >= 3, "{members:?}");
        assert!(
            members.iter().any(|p| p.pgid != root),
            "a member runs in another group"
        );
        assert!(tree.terminate(Duration::from_millis(300)));
        reaper.join().unwrap().unwrap();
        let left: Vec<_> = snapshot()
            .unwrap()
            .into_iter()
            .filter(|p| !p.zombie && members.iter().any(|m| m.pid == p.pid))
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn watchdog_and_sweep_end_registered_processes() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = dir.path().join("processes.tsv");

        let spawn_sleeper = || {
            let mut cmd = Command::new("/bin/sleep");
            cmd.arg("37");
            configure_new_group(&mut cmd);
            cmd.spawn().unwrap()
        };
        let command_of = |pid: u32| {
            snapshot()
                .unwrap()
                .into_iter()
                .find(|p| p.pid == pid)
                .map(|p| p.command)
                .unwrap()
        };

        // Watchdog: closing its pipe ends the registered process.
        let mut a = spawn_sleeper();
        let entry = RegistryEntry {
            pid: a.id(),
            command: command_of(a.id()),
        };
        write_registry(&registry, std::slice::from_ref(&entry)).unwrap();
        let mut watchdog = OrphanWatchdog::start(registry.clone()).unwrap();
        assert!(watchdog.is_running());
        watchdog.ping().unwrap();
        assert!(watchdog.trigger_and_wait(Duration::from_secs(10)));
        let status = a.wait().unwrap();
        assert!(!status.success());

        // Sweep: only processes whose command still matches are ended.
        let mut b = spawn_sleeper();
        let mut c = spawn_sleeper();
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

//! Facts about this computer (SPEC section 6, "Prompt composition", and section 11): operating
//! system and version, the processor architecture of the hardware, CPU name and cores, memory, and
//! the graphics adapters with their vendor.
//!
//! The edit instructions name them when the computer is not an Apple Silicon Mac, because the
//! bundled toolkit was written on one (`jobs::prompt`); Settings shows a one-line summary.
//!
//! The facts are probed once per run ([`facts`], started early by [`probe_in_background`]), off
//! the UI path, with a hard time limit on every helper process and without console windows. A fact
//! that cannot be read is simply missing; nothing here fails.
//!
//! - macOS: `sysctl` (`hw.optional.arm64` and `sysctl.proc_translated` for the hardware, so an
//!   Intel build under Rosetta still reports Apple Silicon; `machdep.cpu.brand_string`,
//!   `hw.physicalcpu`, `hw.logicalcpu`, `hw.memsize`), `sw_vers` and
//!   `system_profiler SPDisplaysDataType -json` (only the model and vendor of each adapter).
//! - Windows: the registry (version, native processor architecture, CPU name), `sysinfo` (memory,
//!   physical cores), and one Windows PowerShell call for the video controllers
//!   (`Win32_VideoController`).
//!
//! No identifier of the computer or its user (names, serial numbers) is ever read into the facts.
//! The decisions and text formatting are pure functions below the probing, tested on their own;
//! on a Mac the probe itself is [`mac_facts`] over the answers of the commands ([`MacQuery`]),
//! tested with recorded answers of an Intel Mac, an Apple Silicon Mac and the Intel build under
//! Rosetta.

use std::sync::OnceLock;

/// The operating system family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    MacOs,
    Windows,
    Other,
}

/// The processor architecture of the hardware (not of the VidAI build).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    Arm64,
    X64,
}

impl Arch {
    pub fn label(self) -> &'static str {
        match self {
            Arch::Arm64 => "arm64",
            Arch::X64 => "x64",
        }
    }

    /// The architecture of this build, the fallback when the hardware cannot be asked.
    fn of_build() -> Option<Arch> {
        if cfg!(target_arch = "aarch64") {
            Some(Arch::Arm64)
        } else if cfg!(target_arch = "x86_64") {
            Some(Arch::X64)
        } else {
            None
        }
    }
}

/// Who made a graphics adapter: it decides which hardware video encoder exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Other,
}

impl GpuVendor {
    pub fn label(self) -> Option<&'static str> {
        match self {
            GpuVendor::Nvidia => Some("NVIDIA"),
            GpuVendor::Amd => Some("AMD"),
            GpuVendor::Intel => Some("Intel"),
            GpuVendor::Apple => Some("Apple"),
            GpuVendor::Other => None,
        }
    }

    /// From a PCI vendor id (`0x10DE` and so on).
    pub fn from_pci_id(id: u16) -> GpuVendor {
        match id {
            0x10DE => GpuVendor::Nvidia,
            0x1002 | 0x1022 => GpuVendor::Amd,
            0x8086 => GpuVendor::Intel,
            0x106B => GpuVendor::Apple,
            _ => GpuVendor::Other,
        }
    }

    /// From any text that names the vendor or a product line ("sppci_vendor_amd",
    /// "NVIDIA GeForce RTX 3060", "Radeon Pro 5500M").
    pub fn from_text(text: &str) -> GpuVendor {
        let text = text.to_ascii_lowercase();
        let has = |words: &[&str]| words.iter().any(|w| text.contains(w));
        if has(&["nvidia", "geforce", "quadro"]) {
            GpuVendor::Nvidia
        } else if has(&["amd", "radeon", "ati technologies"]) {
            GpuVendor::Amd
        } else if has(&["intel"]) {
            GpuVendor::Intel
        } else if has(&["apple"]) {
            GpuVendor::Apple
        } else {
            GpuVendor::Other
        }
    }
}

/// One graphics adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gpu {
    pub name: String,
    pub vendor: GpuVendor,
}

impl Gpu {
    /// The name, followed by the vendor in parentheses when the name does not say it already:
    /// "NVIDIA GeForce RTX 3060", "Radeon RX 580 Series (AMD)".
    pub fn describe(&self) -> String {
        match self.vendor.label() {
            Some(vendor)
                if !self
                    .name
                    .to_ascii_lowercase()
                    .contains(&vendor.to_ascii_lowercase()) =>
            {
                format!("{} ({vendor})", self.name)
            }
            _ => self.name.clone(),
        }
    }
}

/// What VidAI knows about this computer. Every fact but the OS family may be missing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineFacts {
    pub os: Os,
    /// For example "macOS 15.4.1" or "Windows 11 24H2".
    pub os_version: Option<String>,
    /// Of the hardware: an Intel build under Rosetta on Apple Silicon reports [`Arch::Arm64`].
    pub arch: Option<Arch>,
    /// For example "Intel Core i7-12700" or "Apple M3 Max".
    pub cpu: Option<String>,
    pub physical_cores: Option<u32>,
    pub logical_cores: Option<u32>,
    pub memory_bytes: Option<u64>,
    /// `None` when the adapters could not be read, empty when none was found.
    pub gpus: Option<Vec<Gpu>>,
}

impl MachineFacts {
    /// Nothing known but the OS family.
    pub fn unknown(os: Os) -> Self {
        Self {
            os,
            os_version: None,
            arch: None,
            cpu: None,
            physical_cores: None,
            logical_cores: None,
            memory_bytes: None,
            gpus: None,
        }
    }

    /// The machine the toolkit was written for.
    pub fn is_apple_silicon_mac(&self) -> bool {
        self.os == Os::MacOs && self.arch == Some(Arch::Arm64)
    }

    /// "Apple Silicon Mac", "Intel Mac", "Windows PC", ...
    pub fn kind(&self) -> &'static str {
        match (self.os, self.arch) {
            (Os::MacOs, Some(Arch::Arm64)) => "Apple Silicon Mac",
            (Os::MacOs, Some(Arch::X64)) => "Intel Mac",
            (Os::MacOs, None) => "Mac",
            (Os::Windows, _) => "Windows PC",
            (Os::Other, _) => "computer",
        }
    }

    /// The memory in whole gigabytes (GiB, as the system reports it), when known.
    pub fn memory_gb(&self) -> Option<u64> {
        let gb = (self.memory_bytes? as f64 / f64::from(1u32 << 30)).round() as u64;
        (gb > 0).then_some(gb)
    }

    /// "12 cores, 20 threads", "8 cores", "16 threads", or `None`.
    pub fn cores_text(&self) -> Option<String> {
        match (self.physical_cores, self.logical_cores) {
            (Some(p), Some(l)) if p != l => Some(format!("{p} cores, {l} threads")),
            (Some(p), _) => Some(format!("{p} cores")),
            (None, Some(l)) => Some(format!("{l} threads")),
            (None, None) => None,
        }
    }

    /// The vendors of the graphics adapters, each once, in the order found.
    pub fn gpu_vendors(&self) -> Vec<GpuVendor> {
        let mut vendors = Vec::new();
        for gpu in self.gpus.iter().flatten() {
            if !vendors.contains(&gpu.vendor) {
                vendors.push(gpu.vendor);
            }
        }
        vendors
    }

    /// The quiet one-line summary of Settings: "Windows 11 24H2, Intel Core i7-12700, 32 GB,
    /// NVIDIA GeForce RTX 3060". An adapter named like the CPU (Apple Silicon) is left out.
    pub fn summary(&self) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        parts.extend(self.os_version.clone());
        parts.extend(self.cpu.clone());
        parts.extend(self.memory_gb().map(|gb| format!("{gb} GB")));
        for gpu in self.gpus.iter().flatten() {
            if self.cpu.as_deref() != Some(gpu.name.as_str()) && !parts.contains(&gpu.name) {
                parts.push(gpu.name.clone());
            }
        }
        (!parts.is_empty()).then(|| parts.join(", "))
    }
}

static FACTS: OnceLock<MachineFacts> = OnceLock::new();

/// The facts about this computer, probed on the first call (blocking, bounded by the helpers'
/// time limits) and remembered for the rest of the run.
pub fn facts() -> &'static MachineFacts {
    FACTS.get_or_init(probe)
}

/// Whether this computer is an Apple Silicon Mac, by its hardware (an Intel build running under
/// Rosetta counts as Apple Silicon). Quick, remembered for the run, and independent of the slower
/// [`facts`].
pub fn is_apple_silicon_mac() -> bool {
    static APPLE_SILICON: OnceLock<bool> = OnceLock::new();
    *APPLE_SILICON.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            // An arm64 build only runs on Apple Silicon.
            cfg!(target_arch = "aarch64") || mac::hardware_arch() == Some(Arch::Arm64)
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    })
}

/// Starts probing on a background thread, so [`facts`] is ready by the time a job or Settings
/// asks.
pub fn probe_in_background() {
    let spawned = std::thread::Builder::new()
        .name("machine-facts".into())
        .spawn(|| {
            facts();
        });
    if let Err(err) = spawned {
        eprintln!("vidai: could not start probing the machine facts: {err}");
    }
}

/// Reads the facts now.
pub fn probe() -> MachineFacts {
    #[cfg(target_os = "macos")]
    {
        mac::probe()
    }
    #[cfg(windows)]
    {
        win::probe()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        MachineFacts {
            arch: Arch::of_build(),
            logical_cores: logical_cores(),
            ..MachineFacts::unknown(Os::Other)
        }
    }
}

/// The logical processors this process can use.
#[cfg(not(target_os = "macos"))]
fn logical_cores() -> Option<u32> {
    std::thread::available_parallelism()
        .ok()
        .and_then(|n| u32::try_from(n.get()).ok())
}

// ---------------------------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------------------------

/// The hardware architecture of a Mac from `sysctl -n hw.optional.arm64` and
/// `sysctl -n sysctl.proc_translated` (each `None` when it could not be read; an Intel Mac has
/// no `hw.optional.arm64`). Either one being 1 means Apple Silicon. When `sysctl` could not run
/// at all, the build's architecture is the best guess.
pub fn mac_arch(arm64: Option<&str>, translated: Option<&str>, sysctl_ran: bool) -> Option<Arch> {
    let one = |v: Option<&str>| v.map(str::trim) == Some("1");
    if one(arm64) || one(translated) {
        Some(Arch::Arm64)
    } else if sysctl_ran {
        Some(Arch::X64)
    } else {
        Arch::of_build()
    }
}

/// The native processor architecture of a Windows PC from the machine's
/// `PROCESSOR_ARCHITECTURE` (the registry value, which is not changed by emulation).
pub fn windows_arch(value: &str) -> Option<Arch> {
    match value.trim().to_ascii_uppercase().as_str() {
        "AMD64" => Some(Arch::X64),
        "ARM64" => Some(Arch::Arm64),
        _ => None,
    }
}

/// "Windows 11 24H2" from the build number and the display version of the registry. Windows 11
/// still calls itself Windows 10 in `ProductName`; builds from 22000 on are Windows 11.
pub fn windows_version(build: Option<u32>, display_version: Option<&str>) -> String {
    let name = match build {
        Some(b) if b >= 22_000 => "Windows 11",
        Some(b) if b >= 10_240 => "Windows 10",
        _ => "Windows",
    };
    match display_version.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => format!("{name} {v}"),
        None => name.to_owned(),
    }
}

/// A CPU name without trademark marks, clock speed and padding:
/// "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz" becomes "Intel Core i7-9750H".
pub fn clean_cpu_name(raw: &str) -> Option<String> {
    let mut name = without_marks(raw);
    if let Some(at) = name.find('@') {
        name.truncate(at);
    }
    let mut words: Vec<&str> = name.split_whitespace().collect();
    if words.last() == Some(&"CPU") {
        words.pop();
    }
    let name = words.join(" ");
    (!name.is_empty()).then_some(name)
}

/// `text` without trademark marks and with single spaces: "Intel(R) UHD Graphics 770" becomes
/// "Intel UHD Graphics 770".
fn without_marks(text: &str) -> String {
    let mut text = text.to_owned();
    for mark in ["(R)", "(r)", "(TM)", "(tm)"] {
        text = text.replace(mark, "");
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The adapters in the JSON of `system_profiler SPDisplaysDataType -json` (model and vendor
/// only), or `None` when it is not that JSON.
pub fn parse_mac_gpus(json: &str) -> Option<Vec<Gpu>> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let entries = value.get("SPDisplaysDataType")?.as_array()?;
    let mut gpus: Vec<Gpu> = Vec::new();
    for entry in entries {
        let text = |key: &str| entry.get(key).and_then(|v| v.as_str()).unwrap_or("");
        let model = text("sppci_model").trim();
        let name = if model.is_empty() {
            text("_name").trim()
        } else {
            model
        };
        if name.is_empty() || gpus.iter().any(|g| g.name == name) {
            continue;
        }
        // "sppci_vendor_amd", "Intel", or on older systems a name with the PCI id, such as
        // "ATI (0x1002)"; otherwise the model name tells.
        let vendor_text = text("spdisplays_vendor");
        let vendor = match GpuVendor::from_text(vendor_text) {
            GpuVendor::Other => hex_vendor_id(vendor_text)
                .map(GpuVendor::from_pci_id)
                .filter(|v| *v != GpuVendor::Other)
                .unwrap_or_else(|| GpuVendor::from_text(name)),
            vendor => vendor,
        };
        gpus.push(Gpu {
            name: name.to_owned(),
            vendor,
        });
    }
    Some(gpus)
}

/// The adapters in the output of `win::GPU_SCRIPT`: one line per video controller with the
/// name, the PnP device id and the adapter compatibility (the driver's vendor), separated by tabs.
pub fn parse_windows_gpus(text: &str) -> Vec<Gpu> {
    let mut gpus: Vec<Gpu> = Vec::new();
    for line in text.lines() {
        let mut fields = line.split('\t').map(str::trim);
        let name = without_marks(fields.next().unwrap_or(""));
        let device = fields.next().unwrap_or("");
        let compatibility = fields.next().unwrap_or("");
        if name.is_empty() || gpus.iter().any(|g| g.name == name) {
            continue;
        }
        let vendor = pci_vendor_id(device)
            .map(GpuVendor::from_pci_id)
            .filter(|v| *v != GpuVendor::Other)
            .unwrap_or_else(|| match GpuVendor::from_text(compatibility) {
                GpuVendor::Other => GpuVendor::from_text(&name),
                vendor => vendor,
            });
        gpus.push(Gpu { name, vendor });
    }
    gpus
}

/// The PCI vendor id written as `0x` and four hex digits in a text such as "ATI (0x1002)".
fn hex_vendor_id(text: &str) -> Option<u16> {
    let start = text.to_ascii_lowercase().find("0x")? + 2;
    u16::from_str_radix(text.get(start..start + 4)?, 16).ok()
}

/// The vendor id in a PnP device id such as `PCI\VEN_10DE&DEV_2504&...`.
fn pci_vendor_id(device: &str) -> Option<u16> {
    let upper = device.to_ascii_uppercase();
    let start = upper.find("VEN_")? + 4;
    let hex = upper.get(start..start + 4)?;
    u16::from_str_radix(hex, 16).ok()
}

/// What the Mac probe asks the system. The answer is the trimmed standard output of a successful
/// run, `None` when the command failed or printed nothing (an Intel Mac answers
/// `sysctl -n hw.optional.arm64` with "unknown oid" and exit status 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacQuery<'a> {
    /// `sysctl -n <name>`.
    Sysctl(&'a str),
    /// `sw_vers -productVersion`.
    ProductVersion,
    /// `system_profiler SPDisplaysDataType -json`.
    Displays,
}

/// The hardware architecture of a Mac alone, without the slower facts (two quick `sysctl`
/// calls, a third only when both failed).
pub fn mac_hardware_arch(ask: &dyn Fn(MacQuery<'_>) -> Option<String>) -> Option<Arch> {
    let arm64 = ask(MacQuery::Sysctl("hw.optional.arm64"));
    let translated = ask(MacQuery::Sysctl("sysctl.proc_translated"));
    let ran = arm64.is_some() || translated.is_some() || ask(MacQuery::Sysctl("hw.ncpu")).is_some();
    mac_arch(arm64.as_deref(), translated.as_deref(), ran)
}

/// The facts of a Mac from the answers to [`MacQuery`]s.
pub fn mac_facts(ask: &dyn Fn(MacQuery<'_>) -> Option<String>) -> MachineFacts {
    let sysctl = |name: &str| ask(MacQuery::Sysctl(name));
    let arm64 = sysctl("hw.optional.arm64");
    let translated = sysctl("sysctl.proc_translated");
    let cpu = sysctl("machdep.cpu.brand_string");
    let number = |name: &str| sysctl(name).and_then(|v| v.trim().parse::<u64>().ok());
    let physical = number("hw.physicalcpu");
    let logical = number("hw.logicalcpu");
    let memory = number("hw.memsize");
    let sysctl_ran = [&arm64, &translated, &cpu].iter().any(|v| v.is_some()) || physical.is_some();
    MachineFacts {
        os: Os::MacOs,
        os_version: ask(MacQuery::ProductVersion).map(|v| format!("macOS {}", v.trim())),
        arch: mac_arch(arm64.as_deref(), translated.as_deref(), sysctl_ran),
        cpu: cpu.as_deref().and_then(clean_cpu_name),
        physical_cores: physical.and_then(|n| u32::try_from(n).ok()),
        logical_cores: logical.and_then(|n| u32::try_from(n).ok()),
        memory_bytes: memory,
        gpus: ask(MacQuery::Displays).as_deref().and_then(parse_mac_gpus),
    }
}

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod mac {
    use std::process::Command;
    use std::time::Duration;

    use super::{MacQuery, MachineFacts, mac_facts, mac_hardware_arch};
    use crate::platform::output_with_timeout;

    /// For `sysctl` and `sw_vers`, which answer at once.
    const QUICK: Duration = Duration::from_secs(5);
    /// For `system_profiler`, which usually takes well under a second.
    const PROFILER: Duration = Duration::from_secs(15);

    /// The trimmed standard output of a successful run, or `None`.
    fn run(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
        let out = output_with_timeout(Command::new(program).args(args), timeout).ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (!text.is_empty()).then_some(text)
    }

    /// Answers a [`MacQuery`] by running the command.
    fn ask(query: MacQuery<'_>) -> Option<String> {
        match query {
            MacQuery::Sysctl(name) => run("/usr/sbin/sysctl", &["-n", name], QUICK),
            MacQuery::ProductVersion => run("/usr/bin/sw_vers", &["-productVersion"], QUICK),
            MacQuery::Displays => run(
                "/usr/sbin/system_profiler",
                &["SPDisplaysDataType", "-json"],
                PROFILER,
            ),
        }
    }

    /// The hardware architecture alone (an Intel build under Rosetta on Apple Silicon reports
    /// Apple Silicon).
    pub fn hardware_arch() -> Option<super::Arch> {
        mac_hardware_arch(&ask)
    }

    pub fn probe() -> MachineFacts {
        mac_facts(&ask)
    }
}

#[cfg(any(windows, test))]
pub mod win {
    /// Windows PowerShell script that lists the video controllers, one per line: name, PnP
    /// device id and adapter compatibility, separated by tabs, written as UTF-8.
    pub const GPU_SCRIPT: &str = "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n\
        Get-CimInstance -ClassName Win32_VideoController | ForEach-Object { \"$($_.Name)`t$($_.PNPDeviceID)`t$($_.AdapterCompatibility)\" }";

    #[cfg(windows)]
    pub fn probe() -> super::MachineFacts {
        use std::process::Command;
        use std::time::Duration;

        use windows_registry::LOCAL_MACHINE;

        use super::{
            Arch, MachineFacts, Os, clean_cpu_name, logical_cores, parse_windows_gpus,
            windows_arch, windows_version,
        };
        use crate::platform::output_with_timeout;
        use crate::platform::windows::{encode_powershell, powershell_exe};

        /// A cold start of PowerShell on a slow PC can take several seconds.
        const POWERSHELL: Duration = Duration::from_secs(20);

        let read = |path: &str, name: &str| {
            LOCAL_MACHINE
                .open(path)
                .and_then(|key| key.get_string(name))
                .ok()
        };
        let current = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        let build = read(current, "CurrentBuildNumber").and_then(|b| b.trim().parse().ok());
        let display = read(current, "DisplayVersion");
        let arch = read(
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            "PROCESSOR_ARCHITECTURE",
        )
        .as_deref()
        .and_then(windows_arch)
        .or_else(Arch::of_build);
        let cpu = read(
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            "ProcessorNameString",
        )
        .as_deref()
        .and_then(clean_cpu_name);
        let memory = sysinfo::System::new().ok().and_then(|mut system| {
            system.refresh_memory();
            Some(system.total_memory()).filter(|m| *m > 0)
        });
        let physical = sysinfo::System::physical_core_count()
            .ok()
            .and_then(|n| u32::try_from(n).ok());
        let gpus = output_with_timeout(
            Command::new(powershell_exe()).args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &encode_powershell(GPU_SCRIPT),
            ]),
            POWERSHELL,
        )
        .ok()
        .filter(|out| out.status.success())
        .map(|out| parse_windows_gpus(&String::from_utf8_lossy(&out.stdout)));
        MachineFacts {
            os: Os::Windows,
            os_version: Some(windows_version(build, display.as_deref())),
            arch,
            cpu,
            physical_cores: physical,
            logical_cores: logical_cores(),
            memory_bytes: memory,
            gpus,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(name: &str, vendor: GpuVendor) -> Gpu {
        Gpu {
            name: name.to_owned(),
            vendor,
        }
    }

    #[test]
    fn mac_hardware_not_build() {
        // Apple Silicon, native or an Intel build under Rosetta.
        assert_eq!(mac_arch(Some("1"), Some("0"), true), Some(Arch::Arm64));
        assert_eq!(mac_arch(Some("1"), Some("1"), true), Some(Arch::Arm64));
        assert_eq!(mac_arch(None, Some("1\n"), true), Some(Arch::Arm64));
        // An Intel Mac has no hw.optional.arm64 (or 0) and no translation.
        assert_eq!(mac_arch(None, None, true), Some(Arch::X64));
        assert_eq!(mac_arch(Some("0"), Some("0"), true), Some(Arch::X64));
        // sysctl did not run: the build is the best guess.
        assert_eq!(mac_arch(None, None, false), Arch::of_build());
    }

    /// Recorded answers of a Mac: `sysctl` by name, `sw_vers` and `system_profiler` (`None` for
    /// a name the Mac does not know, as `sysctl` fails with "unknown oid").
    fn recorded<'a>(
        sysctl: &'a [(&'a str, &'a str)],
        version: &'a str,
        displays: &'a str,
    ) -> impl Fn(MacQuery<'_>) -> Option<String> + 'a {
        move |query| match query {
            MacQuery::Sysctl(name) => sysctl
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| (*v).to_owned()),
            MacQuery::ProductVersion => Some(version.to_owned()),
            MacQuery::Displays => Some(displays.to_owned()),
        }
    }

    /// `system_profiler SPDisplaysDataType -json` of a 16-inch MacBook Pro (2019): Intel
    /// graphics plus AMD graphics, with the display list left out.
    const INTEL_AND_AMD_DISPLAYS: &str = r#"{
  "SPDisplaysDataType" : [
    {
      "_name" : "Intel UHD Graphics 630",
      "spdisplays_automatic_graphics_switching" : "spdisplays_supported",
      "spdisplays_device-id" : "0x3e9b",
      "spdisplays_gmux-version" : "5.0.0",
      "spdisplays_metal" : "spdisplays_metal3",
      "spdisplays_revision-id" : "0x0002",
      "spdisplays_vendor" : "Intel",
      "spdisplays_vram_shared" : "1536 MB",
      "sppci_bus" : "spdisplays_builtin",
      "sppci_device_type" : "spdisplays_gpu",
      "sppci_model" : "Intel UHD Graphics 630"
    },
    {
      "_name" : "AMD Radeon Pro 5300M",
      "spdisplays_device-id" : "0x7340",
      "spdisplays_efi-version" : "01.01.190",
      "spdisplays_metal" : "spdisplays_metal3",
      "spdisplays_pcie_width" : "x16",
      "spdisplays_revision-id" : "0x0040",
      "spdisplays_vendor" : "sppci_vendor_amd",
      "spdisplays_vram" : "4 GB",
      "sppci_bus" : "spdisplays_pcie_device",
      "sppci_device_type" : "spdisplays_gpu",
      "sppci_model" : "AMD Radeon Pro 5300M"
    }
  ]
}"#;

    /// The same of a Mac mini (2018) with Intel graphics only.
    const INTEL_ONLY_DISPLAYS: &str = r#"{"SPDisplaysDataType":[{"_name":"Intel UHD Graphics 630","spdisplays_vendor":"Intel","sppci_bus":"spdisplays_builtin","sppci_device_type":"spdisplays_gpu","sppci_model":"Intel UHD Graphics 630"}]}"#;

    /// The same of an older MacBook Pro (2015), whose AMD graphics name the vendor by its PCI id.
    const OLDER_AMD_DISPLAYS: &str = r#"{"SPDisplaysDataType":[{"_name":"Intel Iris Pro","spdisplays_vendor":"Intel","sppci_model":"Intel Iris Pro"},{"_name":"R9 M370X","spdisplays_vendor":"ATI (0x1002)","sppci_model":"R9 M370X"}]}"#;

    /// `system_profiler` of an Apple Silicon Mac.
    const APPLE_DISPLAYS: &str = r#"{"SPDisplaysDataType":[{"_name":"kHW_AppleM3MaxItem","spdisplays_mtlgpufamilysupport":"spdisplays_metal3","sppci_bus":"spdisplays_builtin","sppci_cores":"40","sppci_device_type":"spdisplays_gpu","sppci_model":"Apple M3 Max","spdisplays_vendor":"sppci_vendor_Apple"}]}"#;

    /// An Intel Mac: no `hw.optional.arm64` at all (or 0 on some versions), not translated.
    #[test]
    fn recorded_intel_mac() {
        let sysctl = [
            ("sysctl.proc_translated", "0"),
            (
                "machdep.cpu.brand_string",
                "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
            ),
            ("hw.physicalcpu", "6"),
            ("hw.logicalcpu", "12"),
            ("hw.memsize", "17179869184"),
            ("hw.ncpu", "12"),
        ];
        let ask = recorded(&sysctl, "15.7.2\n", INTEL_AND_AMD_DISPLAYS);
        let facts = mac_facts(&ask);
        assert_eq!(
            facts,
            MachineFacts {
                os: Os::MacOs,
                os_version: Some("macOS 15.7.2".into()),
                arch: Some(Arch::X64),
                cpu: Some("Intel Core i7-9750H".into()),
                physical_cores: Some(6),
                logical_cores: Some(12),
                memory_bytes: Some(17_179_869_184),
                gpus: Some(vec![
                    gpu("Intel UHD Graphics 630", GpuVendor::Intel),
                    gpu("AMD Radeon Pro 5300M", GpuVendor::Amd),
                ]),
            }
        );
        assert_eq!(mac_hardware_arch(&ask), Some(Arch::X64));
        assert!(!facts.is_apple_silicon_mac());
        assert_eq!(facts.kind(), "Intel Mac");
        assert_eq!(facts.memory_gb(), Some(16));
        assert_eq!(
            facts.summary().as_deref(),
            Some(
                "macOS 15.7.2, Intel Core i7-9750H, 16 GB, Intel UHD Graphics 630, AMD Radeon Pro 5300M"
            )
        );

        // macOS 10.15 knows neither name; hw.optional.arm64 = 0 on others: still Intel.
        let catalina = [("hw.ncpu", "4")];
        assert_eq!(
            mac_hardware_arch(&recorded(&catalina, "10.15.7", "")),
            Some(Arch::X64)
        );
        let zero = [("hw.optional.arm64", "0"), ("sysctl.proc_translated", "0")];
        assert_eq!(mac_hardware_arch(&recorded(&zero, "", "")), Some(Arch::X64));

        // Intel graphics only, and the older vendor form with the PCI id.
        assert_eq!(
            parse_mac_gpus(INTEL_ONLY_DISPLAYS),
            Some(vec![gpu("Intel UHD Graphics 630", GpuVendor::Intel)])
        );
        assert_eq!(
            parse_mac_gpus(OLDER_AMD_DISPLAYS),
            Some(vec![
                gpu("Intel Iris Pro", GpuVendor::Intel),
                gpu("R9 M370X", GpuVendor::Amd),
            ])
        );
    }

    /// Apple Silicon, natively and with the Intel build under Rosetta (which reports its CPU as
    /// the Apple chip and `sysctl.proc_translated` as 1): both are Apple Silicon.
    #[test]
    fn recorded_apple_silicon_and_rosetta() {
        let native = [
            ("hw.optional.arm64", "1"),
            ("sysctl.proc_translated", "0"),
            ("machdep.cpu.brand_string", "Apple M3 Max"),
            ("hw.physicalcpu", "16"),
            ("hw.logicalcpu", "16"),
            ("hw.memsize", "68719476736"),
        ];
        let rosetta = [
            ("hw.optional.arm64", "1"),
            ("sysctl.proc_translated", "1"),
            ("machdep.cpu.brand_string", "Apple M3 Max"),
            ("hw.physicalcpu", "16"),
            ("hw.logicalcpu", "16"),
            ("hw.memsize", "68719476736"),
        ];
        for sysctl in [&native[..], &rosetta[..]] {
            let ask = recorded(sysctl, "26.6.2", APPLE_DISPLAYS);
            let facts = mac_facts(&ask);
            assert_eq!(facts.arch, Some(Arch::Arm64));
            assert!(facts.is_apple_silicon_mac());
            assert_eq!(mac_hardware_arch(&ask), Some(Arch::Arm64));
            assert_eq!(
                facts.summary().as_deref(),
                Some("macOS 26.6.2, Apple M3 Max, 64 GB")
            );
        }
        // A translated process on a Mac whose hw.optional.arm64 could not be read.
        let translated_only = [("sysctl.proc_translated", "1")];
        assert_eq!(
            mac_hardware_arch(&recorded(&translated_only, "", "")),
            Some(Arch::Arm64)
        );
        // Nothing answered at all: the build's architecture is the best guess.
        let nothing: [(&str, &str); 0] = [];
        let ask = |_: MacQuery<'_>| None;
        assert_eq!(mac_hardware_arch(&ask), Arch::of_build());
        assert_eq!(
            mac_facts(&recorded(&nothing, "15.0", "not json")).gpus,
            None
        );
    }

    #[test]
    fn windows_architecture_and_version() {
        assert_eq!(windows_arch("AMD64"), Some(Arch::X64));
        assert_eq!(windows_arch(" arm64 "), Some(Arch::Arm64));
        assert_eq!(windows_arch("x86"), None);
        assert_eq!(
            windows_version(Some(26_100), Some("24H2")),
            "Windows 11 24H2"
        );
        assert_eq!(windows_version(Some(22_000), None), "Windows 11");
        assert_eq!(
            windows_version(Some(19_045), Some("22H2")),
            "Windows 10 22H2"
        );
        assert_eq!(windows_version(Some(17_763), Some(" ")), "Windows 10");
        assert_eq!(windows_version(None, None), "Windows");
    }

    #[test]
    fn cpu_names_are_cleaned() {
        let clean = |raw: &str| clean_cpu_name(raw).unwrap_or_default();
        assert_eq!(
            clean("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz"),
            "Intel Core i7-9750H"
        );
        assert_eq!(
            clean("12th Gen Intel(R) Core(TM) i7-12700"),
            "12th Gen Intel Core i7-12700"
        );
        assert_eq!(
            clean("AMD Ryzen 9 5900X 12-Core Processor            "),
            "AMD Ryzen 9 5900X 12-Core Processor"
        );
        assert_eq!(
            clean("Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz"),
            "Intel Xeon Platinum 8370C"
        );
        assert_eq!(clean("Apple M3 Max"), "Apple M3 Max");
        assert_eq!(clean_cpu_name("  "), None);
    }

    #[test]
    fn vendors() {
        assert_eq!(GpuVendor::from_pci_id(0x10DE), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_pci_id(0x1002), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_pci_id(0x8086), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_pci_id(0x1414), GpuVendor::Other);
        assert_eq!(GpuVendor::from_text("sppci_vendor_Apple"), GpuVendor::Apple);
        assert_eq!(GpuVendor::from_text("sppci_vendor_amd"), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_text("Radeon Pro 5500M"), GpuVendor::Amd);
        assert_eq!(
            GpuVendor::from_text("Intel UHD Graphics 630"),
            GpuVendor::Intel
        );
        assert_eq!(
            GpuVendor::from_text("NVIDIA GeForce RTX 3060"),
            GpuVendor::Nvidia
        );
        assert_eq!(GpuVendor::from_text("Microsoft"), GpuVendor::Other);
        assert_eq!(
            gpu("NVIDIA GeForce RTX 3060", GpuVendor::Nvidia).describe(),
            "NVIDIA GeForce RTX 3060"
        );
        assert_eq!(
            gpu("Radeon RX 580 Series", GpuVendor::Amd).describe(),
            "Radeon RX 580 Series (AMD)"
        );
        assert_eq!(
            gpu("Microsoft Basic Display Adapter", GpuVendor::Other).describe(),
            "Microsoft Basic Display Adapter"
        );
    }

    #[test]
    fn mac_gpus_from_system_profiler() {
        let json = r#"{"SPDisplaysDataType":[
            {"_name":"Intel UHD Graphics 630","sppci_model":"Intel UHD Graphics 630","spdisplays_vendor":"sppci_vendor_intel",
             "spdisplays_ndrvs":[{"_name":"Color LCD","_spdisplays_display-serial-number":"fd626d62"}]},
            {"_name":"AMD Radeon Pro 5500M","sppci_model":"AMD Radeon Pro 5500M","spdisplays_vendor":"sppci_vendor_amd"},
            {"_name":"kHW_AppleM3MaxItem","sppci_model":"Apple M3 Max","spdisplays_vendor":"sppci_vendor_Apple"},
            {"sppci_model":"Apple M3 Max","spdisplays_vendor":"sppci_vendor_Apple"}
        ]}"#;
        assert_eq!(
            parse_mac_gpus(json),
            Some(vec![
                gpu("Intel UHD Graphics 630", GpuVendor::Intel),
                gpu("AMD Radeon Pro 5500M", GpuVendor::Amd),
                gpu("Apple M3 Max", GpuVendor::Apple),
            ])
        );
        assert_eq!(
            parse_mac_gpus(r#"{"SPDisplaysDataType":[]}"#),
            Some(Vec::new())
        );
        assert_eq!(parse_mac_gpus("not json"), None);
    }

    #[test]
    fn windows_gpus_from_video_controllers() {
        let text = "NVIDIA GeForce RTX 3060\tPCI\\VEN_10DE&DEV_2504&SUBSYS_88671043&REV_A1\\4&1\tNVIDIA\r\n\
            Intel(R) UHD Graphics 770\tPCI\\VEN_8086&DEV_4690&SUBSYS_86941043&REV_0C\\3&1\tIntel Corporation\r\n\
            Microsoft Hyper-V Video\tVMBUS\\{DA0A7802-E377-4AAC-8E77-0558EB1073F8}\tMicrosoft\r\n\
            Radeon RX 580 Series\t\tAdvanced Micro Devices, Inc.\r\n\
            NVIDIA GeForce RTX 3060\tPCI\\VEN_10DE&DEV_2504\tNVIDIA\r\n\
            \r\n";
        assert_eq!(
            parse_windows_gpus(text),
            vec![
                gpu("NVIDIA GeForce RTX 3060", GpuVendor::Nvidia),
                gpu("Intel UHD Graphics 770", GpuVendor::Intel),
                gpu("Microsoft Hyper-V Video", GpuVendor::Other),
                gpu("Radeon RX 580 Series", GpuVendor::Amd),
            ]
        );
        assert!(parse_windows_gpus("").is_empty());
        // The script prints exactly the three fields the parser reads.
        assert!(
            win::GPU_SCRIPT.contains("$($_.Name)`t$($_.PNPDeviceID)`t$($_.AdapterCompatibility)")
        );
    }

    #[test]
    fn summary_and_derived_facts() {
        let windows = MachineFacts {
            os: Os::Windows,
            os_version: Some("Windows 11 24H2".into()),
            arch: Some(Arch::X64),
            cpu: Some("Intel Core i7-12700".into()),
            physical_cores: Some(12),
            logical_cores: Some(20),
            memory_bytes: Some(34_105_000_000),
            gpus: Some(vec![
                gpu("NVIDIA GeForce RTX 3060", GpuVendor::Nvidia),
                gpu("Intel(R) UHD Graphics 770", GpuVendor::Intel),
                gpu("NVIDIA T400", GpuVendor::Nvidia),
            ]),
        };
        assert_eq!(
            windows.summary().as_deref(),
            Some(
                "Windows 11 24H2, Intel Core i7-12700, 32 GB, NVIDIA GeForce RTX 3060, Intel(R) UHD Graphics 770, NVIDIA T400"
            )
        );
        assert_eq!(windows.kind(), "Windows PC");
        assert!(!windows.is_apple_silicon_mac());
        assert_eq!(
            windows.cores_text().as_deref(),
            Some("12 cores, 20 threads")
        );
        assert_eq!(
            windows.gpu_vendors(),
            vec![GpuVendor::Nvidia, GpuVendor::Intel]
        );

        let apple = MachineFacts {
            os: Os::MacOs,
            os_version: Some("macOS 26.6.2".into()),
            arch: Some(Arch::Arm64),
            cpu: Some("Apple M3 Max".into()),
            physical_cores: Some(16),
            logical_cores: Some(16),
            memory_bytes: Some(68_719_476_736),
            gpus: Some(vec![gpu("Apple M3 Max", GpuVendor::Apple)]),
        };
        assert_eq!(
            apple.summary().as_deref(),
            Some("macOS 26.6.2, Apple M3 Max, 64 GB")
        );
        assert!(apple.is_apple_silicon_mac());
        assert_eq!(apple.kind(), "Apple Silicon Mac");
        assert_eq!(apple.cores_text().as_deref(), Some("16 cores"));

        let intel_mac = MachineFacts {
            arch: Some(Arch::X64),
            ..apple.clone()
        };
        assert!(!intel_mac.is_apple_silicon_mac());
        assert_eq!(intel_mac.kind(), "Intel Mac");

        let nothing = MachineFacts::unknown(Os::Windows);
        assert_eq!(nothing.summary(), None);
        assert_eq!(nothing.memory_gb(), None);
        assert_eq!(nothing.cores_text(), None);
        assert!(nothing.gpu_vendors().is_empty());
        assert_eq!(
            MachineFacts {
                logical_cores: Some(4),
                ..nothing
            }
            .cores_text()
            .as_deref(),
            Some("4 threads")
        );
    }

    /// The real Mac: complete facts, and the hardware, not the build, decides (an Intel build
    /// under Rosetta still reports Apple Silicon, so its edit instructions stay unchanged).
    #[cfg(target_os = "macos")]
    #[test]
    fn probes_this_mac() {
        let facts = probe();
        eprintln!("machine facts: {facts:?}");
        assert_eq!(facts.os, Os::MacOs);
        assert!(
            facts
                .os_version
                .as_deref()
                .is_some_and(|v| v.starts_with("macOS 1") || v.starts_with("macOS 2"))
        );
        assert!(facts.cpu.as_deref().is_some_and(|c| !c.is_empty()));
        assert!(facts.physical_cores.is_some_and(|n| n >= 1));
        assert!(facts.logical_cores >= facts.physical_cores);
        assert!(facts.memory_gb().is_some_and(|gb| gb >= 2));
        assert!(facts.gpus.as_ref().is_some_and(|g| !g.is_empty()));
        let translated = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "sysctl.proc_translated"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
            .unwrap_or(false);
        if cfg!(target_arch = "aarch64") || translated {
            assert_eq!(facts.arch, Some(Arch::Arm64));
            assert!(facts.is_apple_silicon_mac());
        }
        assert!(facts.summary().is_some());
    }

    /// The real Windows PC (the CI runner): sane, non-empty facts.
    #[cfg(windows)]
    #[test]
    fn probes_this_pc() {
        let facts = probe();
        eprintln!("machine facts: {facts:?}");
        assert_eq!(facts.os, Os::Windows);
        let version = facts.os_version.clone().unwrap_or_default();
        assert!(
            version.starts_with("Windows 10") || version.starts_with("Windows 11"),
            "{version}"
        );
        assert!(facts.arch.is_some());
        assert!(facts.cpu.as_deref().is_some_and(|c| !c.is_empty()));
        assert!(facts.physical_cores.is_some_and(|n| n >= 1));
        assert!(facts.logical_cores >= facts.physical_cores);
        assert!(facts.memory_gb().is_some_and(|gb| gb >= 2));
        // The video controller query ran (a virtual machine may have no real GPU).
        let gpus = facts.gpus.clone().expect("the video controllers were read");
        assert!(gpus.iter().all(|g| !g.name.trim().is_empty()));
        assert!(!facts.is_apple_silicon_mac());
        assert!(facts.summary().is_some_and(|s| s.starts_with("Windows 1")));
    }
}

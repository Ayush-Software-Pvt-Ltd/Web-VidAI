//! Whether a program file can run on this Mac's processor (SPEC section 6, Finding and checking
//! Claude Code).
//!
//! A Mac can hold programs built for the other processor: a home folder or `/usr/local` copied
//! from an Intel Mac to an Apple Silicon Mac (Migration Assistant), or the other way round, or a
//! download of the wrong build. An Intel Mac cannot run an `arm64`-only program at all ("Bad CPU
//! type in executable"), and an Apple Silicon Mac runs an `x86_64`-only program only when Rosetta 2
//! is installed (otherwise macOS offers to install it in a dialog). Program lookups skip such a
//! file and go on to the next candidate, as `which` would if the file were not there.
//!
//! Only the Mach-O header is read (the first bytes of the file). Anything that is not a Mach-O
//! file (a `#!` script, an npm shim) or cannot be read counts as runnable: the kernel decides.

use std::io::Read;
use std::path::Path;

/// `CPU_TYPE_X86_64` of `<mach/machine.h>`.
const CPU_X86_64: u32 = 0x0100_0007;
/// `CPU_TYPE_ARM64` (arm64 and arm64e) of `<mach/machine.h>`.
const CPU_ARM64: u32 = 0x0100_000C;

/// Where Rosetta 2 keeps its runtime once it is installed.
const ROSETTA_RUNTIME: &str = "/Library/Apple/usr/libexec/oah/libRosettaRuntime";

/// The CPU types of the slices of a Mach-O file from its first bytes, or `None` when the bytes
/// are not the start of a Mach-O file (or are cut off before the slice list ends). A thin file
/// has one slice, a universal ("fat") file one per architecture.
pub fn cpu_types(header: &[u8]) -> Option<Vec<u32>> {
    let word = |at: usize, big_endian: bool| -> Option<u32> {
        let bytes: [u8; 4] = header.get(at..at + 4)?.try_into().ok()?;
        Some(if big_endian {
            u32::from_be_bytes(bytes)
        } else {
            u32::from_le_bytes(bytes)
        })
    };
    match word(0, true)? {
        // A thin file in the byte order of the machine it was built for (every Mac is little
        // endian): the CPU type follows the magic.
        0xCFFA_EDFE | 0xCEFA_EDFE => Some(vec![word(4, false)?]),
        // A universal file: big-endian header, then `fat_arch` (20 bytes) or `fat_arch_64`
        // (32 bytes) entries that start with the CPU type. Java class files share 0xCAFEBABE;
        // their next word is a version number far above any real slice count.
        magic @ (0xCAFE_BABE | 0xCAFE_BABF) => {
            let count = word(4, true)? as usize;
            if count == 0 || count > 30 {
                return None;
            }
            let size = if magic == 0xCAFE_BABE { 20 } else { 32 };
            (0..count).map(|i| word(8 + i * size, true)).collect()
        }
        _ => None,
    }
}

/// Whether a program with slices for `cpus` runs on this hardware: Apple Silicon runs `arm64`
/// natively and `x86_64` only with Rosetta 2; an Intel Mac runs `x86_64` only.
pub fn runs_on(cpus: &[u32], apple_silicon: bool, rosetta: bool) -> bool {
    let has = |cpu: u32| cpus.contains(&cpu);
    if apple_silicon {
        has(CPU_ARM64) || (rosetta && has(CPU_X86_64))
    } else {
        has(CPU_X86_64)
    }
}

/// Whether the program file `path` can run on this computer. True for anything that is not a
/// Mach-O file, for a file that cannot be read, and on every system but macOS.
pub fn runs_here(path: &Path) -> bool {
    !cfg!(target_os = "macos")
        || file_runs_on(
            path,
            super::machine::is_apple_silicon_mac(),
            rosetta_installed,
        )
}

/// [`runs_here`] for a Mac of the given kind; `rosetta` is asked only when it matters.
pub fn file_runs_on(path: &Path, apple_silicon: bool, rosetta: impl Fn() -> bool) -> bool {
    let mut header = [0u8; 4096];
    let Ok(read) =
        std::fs::File::open(path).and_then(|mut file| read_up_to(&mut file, &mut header))
    else {
        return true;
    };
    match cpu_types(&header[..read]) {
        Some(cpus) => runs_on(&cpus, apple_silicon, apple_silicon && rosetta()),
        None => true,
    }
}

/// Whether Rosetta 2 is installed (only asked on Apple Silicon).
fn rosetta_installed() -> bool {
    Path::new(ROSETTA_RUNTIME).exists()
}

/// Reads until `buf` is full or the file ends; the number of bytes read.
fn read_up_to(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first bytes of a thin 64-bit Mach-O file for `cpu`.
    fn thin(cpu: u32) -> Vec<u8> {
        let mut bytes = vec![0xCF, 0xFA, 0xED, 0xFE];
        bytes.extend_from_slice(&cpu.to_le_bytes());
        bytes.extend_from_slice(&[0; 24]);
        bytes
    }

    /// The first bytes of a universal Mach-O file with one slice per entry of `cpus`.
    fn fat(cpus: &[u32]) -> Vec<u8> {
        let mut bytes = 0xCAFE_BABEu32.to_be_bytes().to_vec();
        bytes.extend_from_slice(&(cpus.len() as u32).to_be_bytes());
        for cpu in cpus {
            bytes.extend_from_slice(&cpu.to_be_bytes());
            bytes.extend_from_slice(&[0; 16]);
        }
        bytes
    }

    #[test]
    fn reads_thin_and_universal_headers() {
        assert_eq!(cpu_types(&thin(CPU_X86_64)), Some(vec![CPU_X86_64]));
        assert_eq!(cpu_types(&thin(CPU_ARM64)), Some(vec![CPU_ARM64]));
        assert_eq!(
            cpu_types(&fat(&[CPU_X86_64, CPU_ARM64])),
            Some(vec![CPU_X86_64, CPU_ARM64])
        );
        // Scripts, npm shims, Java class files and cut-off headers are no Mach-O slices.
        assert_eq!(cpu_types(b"#!/bin/sh\nexec opencode \"$@\"\n"), None);
        assert_eq!(cpu_types(b""), None);
        assert_eq!(cpu_types(&[0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52]), None);
        assert_eq!(cpu_types(&fat(&[CPU_X86_64, CPU_ARM64])[..20]), None);
    }

    /// Every combination an Intel Mac and an Apple Silicon Mac (with and without Rosetta 2) meet.
    #[test]
    fn which_slices_run_where() {
        let intel = [CPU_X86_64];
        let arm = [CPU_ARM64];
        let universal = [CPU_X86_64, CPU_ARM64];
        // An Intel Mac: never an arm64-only program.
        assert!(runs_on(&intel, false, false));
        assert!(runs_on(&universal, false, false));
        assert!(!runs_on(&arm, false, false));
        // Apple Silicon: arm64 always, x86_64 only with Rosetta.
        assert!(runs_on(&arm, true, false));
        assert!(runs_on(&universal, true, false));
        assert!(!runs_on(&intel, true, false));
        assert!(runs_on(&intel, true, true));
        assert!(!runs_on(&[], true, true));
    }

    /// Files on disk, decided for an Intel Mac and for Apple Silicon with and without Rosetta.
    #[test]
    fn files_on_an_intel_mac_and_on_apple_silicon() {
        let dir = tempfile::TempDir::new().unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        };
        let arm = write("arm", &thin(CPU_ARM64));
        let intel = write("intel", &thin(CPU_X86_64));
        let universal = write("universal", &fat(&[CPU_X86_64, CPU_ARM64]));
        let script = write("script", b"#!/bin/sh\necho 1.18.31\n");
        let missing = dir.path().join("missing");
        let intel_mac = |path: &Path| file_runs_on(path, false, || unreachable!());
        assert!(!intel_mac(&arm));
        assert!(intel_mac(&intel));
        assert!(intel_mac(&universal));
        assert!(intel_mac(&script));
        assert!(intel_mac(&missing));
        let apple = |path: &Path, rosetta: bool| file_runs_on(path, true, || rosetta);
        assert!(apple(&arm, false));
        assert!(!apple(&intel, false));
        assert!(apple(&intel, true));
        assert!(apple(&universal, false));
        assert!(apple(&script, false));
    }

    /// Real programs of this Mac: a script and a system binary always run here.
    #[cfg(target_os = "macos")]
    #[test]
    fn real_files() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = dir.path().join("tool");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        assert!(runs_here(&script));
        assert!(runs_here(Path::new("/bin/ls")));
        assert!(runs_here(&dir.path().join("missing")));
        // The other processor's thin build: only Apple Silicon with Rosetta runs an Intel one.
        let other = dir.path().join("other");
        let apple_silicon = crate::platform::machine::is_apple_silicon_mac();
        let other_cpu = if apple_silicon { CPU_X86_64 } else { CPU_ARM64 };
        std::fs::write(&other, thin(other_cpu)).unwrap();
        assert_eq!(runs_here(&other), apple_silicon && rosetta_installed());
    }
}

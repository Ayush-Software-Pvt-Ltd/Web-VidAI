//! Build script: builds the native helpers, then runs `tauri_build`.
//!
//! `vidai-orient` (src-tauri/helpers/orient/main.swift) is the picture check of the Long / Short
//! detection (SPEC section 8). Tauri expects one sidecar per target triple
//! (`binaries/vidai-orient-<target triple>`, listed under `bundle.externalBin` in
//! `tauri.macos.conf.json`). For any macOS target this script compiles the helper with `swiftc`
//! for both Mac architectures and the app's minimum macOS version, joins the two slices with
//! `lipo`, and writes all three sidecars from the same source:
//!
//! - `vidai-orient-aarch64-apple-darwin` (Apple Silicon),
//! - `vidai-orient-x86_64-apple-darwin` (Intel),
//! - `vidai-orient-universal-apple-darwin` (both, for `tauri build --target
//!   universal-apple-darwin`, which runs cargo once per architecture and then bundles this one).
//!
//! Writing all three every time means a universal bundle never picks up a slice that is older
//! than the source, whatever was built before. `tauri_build` copies the sidecar of the cargo
//! target next to the app binary in `target/[<triple>/]<profile>` for debug runs and tests, and
//! the bundler puts it in `VidAI.app/Contents/MacOS` and signs it with the app.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;

const ORIENT_SOURCE: &str = "helpers/orient/main.swift";
const ORIENT_NAME: &str = "vidai-orient";

/// The Mac architectures: Rust target triple and the matching `swiftc` / `lipo` name.
const MAC_ARCHS: [(&str, &str); 2] = [
    ("aarch64-apple-darwin", "arm64"),
    ("x86_64-apple-darwin", "x86_64"),
];

/// Tauri's target triple for a universal (Apple Silicon and Intel) macOS bundle.
const UNIVERSAL_TRIPLE: &str = "universal-apple-darwin";

fn main() {
    build_orient_helper();
    // Windows (MSVC): one manifest for every binary, the test binaries included, which otherwise
    // fail to start (STATUS_ENTRYPOINT_NOT_FOUND). Tauri's own manifest is turned off so there
    // is only one. See windows-app-manifest.xml and SPEC section 11.
    let var = |name: &str| env::var(name).unwrap_or_default();
    if var("CARGO_CFG_TARGET_OS") == "windows" && var("CARGO_CFG_TARGET_ENV") == "msvc" {
        let manifest = Path::new(&var("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run tauri-build");
        return;
    }
    tauri_build::build();
}

fn build_orient_helper() {
    println!("cargo:rerun-if-changed={ORIENT_SOURCE}");
    let target = env::var("TARGET").expect("cargo sets TARGET");
    if !target.ends_with("-apple-darwin") {
        // Other platforms implement the picture check differently (see `platform::orientation`).
        return;
    }
    if !cfg!(target_os = "macos") {
        panic!("building VidAI for macOS needs a Mac with the Xcode command line tools");
    }
    assert!(
        MAC_ARCHS.iter().any(|&(triple, _)| triple == target),
        "vidai-orient: unsupported macOS target {target}"
    );
    let min_macos = minimum_macos_version();
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));

    // Both slices at once: each is its own `swiftc` process.
    let mut built: Vec<(&str, PathBuf)> = thread::scope(|scope| {
        let jobs: Vec<_> = MAC_ARCHS
            .iter()
            .map(|&(triple, arch)| {
                let (min_macos, out_dir) = (&min_macos, &out_dir);
                (
                    triple,
                    scope.spawn(move || compile_orient(arch, min_macos, out_dir)),
                )
            })
            .collect();
        jobs.into_iter()
            .map(|(triple, job)| (triple, job.join().expect("the vidai-orient build panicked")))
            .collect()
    });

    let universal_dir = out_dir.join("universal");
    create_dir(&universal_dir);
    let universal = universal_dir.join(ORIENT_NAME);
    let mut lipo = Command::new("xcrun");
    lipo.args(["lipo", "-create", "-output"])
        .arg(&universal)
        .args(built.iter().map(|(_, slice)| slice));
    run_tool(&mut lipo, "lipo");
    built.push((UNIVERSAL_TRIPLE, universal));

    for (triple, file) in &built {
        copy_if_changed(
            file,
            &Path::new("binaries").join(format!("{ORIENT_NAME}-{triple}")),
        );
    }
}

/// Compiles the helper for one architecture (`arm64` or `x86_64`) into `<out_dir>/<arch>/`.
/// Every architecture uses the same file name, because the linker's signature records it.
fn compile_orient(arch: &str, min_macos: &str, out_dir: &Path) -> PathBuf {
    let dir = out_dir.join(arch);
    create_dir(&dir);
    let built = dir.join(ORIENT_NAME);
    let mut swiftc = Command::new("xcrun");
    swiftc
        .args(["--sdk", "macosx", "swiftc"])
        .args(["-O", "-whole-module-optimization", "-swift-version", "5"])
        .arg("-target")
        .arg(format!("{arch}-apple-macos{min_macos}"))
        .args(["-framework", "AVFoundation", "-framework", "Vision"])
        .arg("-o")
        .arg(&built)
        .arg(ORIENT_SOURCE)
        // Keep swiftc's module cache inside the build directory.
        .env("CLANG_MODULE_CACHE_PATH", dir.join("swift-module-cache"));
    let stderr = run_tool(&mut swiftc, "swiftc");
    // Show compiler warnings (a newer SDK may deprecate something) without failing the build.
    for line in stderr.lines().filter(|l| l.contains("warning:")) {
        println!("cargo:warning=vidai-orient ({arch}): {line}");
    }
    built
}

/// Runs an Xcode tool (`cmd` is `xcrun <tool> ...`), panics with its output when it fails, and
/// returns what it wrote to stderr.
fn run_tool(cmd: &mut Command, tool: &str) -> String {
    let output = cmd.output().unwrap_or_else(|e| {
        panic!(
            "vidai-orient: could not run `xcrun {tool}` (install the Xcode command line tools): {e}"
        )
    });
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        output.status.success(),
        "vidai-orient: `xcrun {tool}` failed ({}):\n{stderr}",
        output.status
    );
    stderr
}

/// `bundle.macOS.minimumSystemVersion` from the Tauri configuration (the macOS file wins).
fn minimum_macos_version() -> String {
    let read = |file: &str| -> Option<String> {
        let text = fs::read_to_string(file).ok()?;
        let config: serde_json::Value = serde_json::from_str(&text).ok()?;
        config
            .pointer("/bundle/macOS/minimumSystemVersion")?
            .as_str()
            .map(str::to_owned)
    };
    read("tauri.macos.conf.json")
        .or_else(|| read("tauri.conf.json"))
        .unwrap_or_else(|| panic!("tauri.conf.json must set bundle.macOS.minimumSystemVersion"))
}

fn create_dir(dir: &Path) {
    fs::create_dir_all(dir).unwrap_or_else(|e| panic!("could not create {}: {e}", dir.display()));
}

/// Copies only when the content differs, so an unchanged helper does not look modified to
/// cargo (`tauri_build` watches the sidecar file).
fn copy_if_changed(from: &Path, to: &Path) {
    let new = fs::read(from).unwrap_or_else(|e| panic!("could not read {}: {e}", from.display()));
    if fs::read(to).is_ok_and(|old| old == new) {
        return;
    }
    if let Some(dir) = to.parent() {
        create_dir(dir);
    }
    // Write next to the destination, then rename, so a concurrent build never sees half a file.
    let tmp = to.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, &new).unwrap_or_else(|e| panic!("could not write {}: {e}", tmp.display()));
    set_executable(&tmp);
    fs::rename(&tmp, to).unwrap_or_else(|e| panic!("could not write {}: {e}", to.display()));
}

#[cfg(unix)]
fn set_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|e| panic!("could not make {} executable: {e}", path.display()));
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) {}

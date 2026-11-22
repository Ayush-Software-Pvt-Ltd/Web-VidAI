//! Build script: makes sure the picture-check helper `vidai-orient` exists, then runs
//! `tauri_build`.
//!
//! `tauri.macos.conf.json` lists `../src-tauri/binaries/vidai-orient` as a sidecar, which
//! `tauri_build` copies next to the `vidai-web` binary (where the core looks for it, see
//! `platform::orientation::helper`). The core's own build script writes that file, but cargo does
//! not order it before this one, so on a clean build it may not be there yet; then the helper for
//! the architecture being built is compiled here from the same source with the same flags.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const ORIENT_SOURCE: &str = "../src-tauri/helpers/orient/main.swift";
const ORIENT_NAME: &str = "vidai-orient";

fn main() {
    check_ui();
    ensure_orient_helper();
    // Windows (MSVC): the core's manifest (Common Controls 6, long paths) for every binary, the
    // test binaries included, exactly as in src-tauri/build.rs. Tauri's own is turned off.
    let var = |name: &str| env::var(name).unwrap_or_default();
    if var("CARGO_CFG_TARGET_OS") == "windows" && var("CARGO_CFG_TARGET_ENV") == "msvc" {
        let manifest =
            Path::new(&var("CARGO_MANIFEST_DIR")).join("../src-tauri/windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run tauri-build");
        return;
    }
    tauri_build::build();
}

fn ensure_orient_helper() {
    println!("cargo:rerun-if-changed={ORIENT_SOURCE}");
    let target = env::var("TARGET").expect("cargo sets TARGET");
    let arch = match target.as_str() {
        "aarch64-apple-darwin" => "arm64",
        "x86_64-apple-darwin" => "x86_64",
        // Windows and the rest have no sidecar; a universal build is made of the two above.
        _ => return,
    };
    let sidecar = PathBuf::from(format!("../src-tauri/binaries/{ORIENT_NAME}-{target}"));
    if sidecar.exists() {
        return;
    }
    if !cfg!(target_os = "macos") {
        panic!("building VidAI Web for macOS needs a Mac with the Xcode command line tools");
    }
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let built = out_dir.join(ORIENT_NAME);
    let status = Command::new("xcrun")
        .args(["--sdk", "macosx", "swiftc"])
        .args(["-O", "-whole-module-optimization", "-swift-version", "5"])
        .arg("-target")
        .arg(format!("{arch}-apple-macos{}", minimum_macos_version()))
        .args(["-framework", "AVFoundation", "-framework", "Vision"])
        .arg("-o")
        .arg(&built)
        .arg(ORIENT_SOURCE)
        .env(
            "CLANG_MODULE_CACHE_PATH",
            out_dir.join("swift-module-cache"),
        )
        .status()
        .unwrap_or_else(|e| panic!("vidai-orient: could not run swiftc (Xcode tools): {e}"));
    assert!(status.success(), "vidai-orient: swiftc failed ({status})");
    if let Some(dir) = sidecar.parent() {
        fs::create_dir_all(dir).expect("could not create src-tauri/binaries");
    }
    // Next to the destination, then renamed, so the core's build never sees half a file.
    let tmp = sidecar.with_extension(format!("tmp-{}", std::process::id()));
    fs::copy(&built, &tmp).expect("could not copy the vidai-orient helper");
    fs::rename(&tmp, &sidecar).expect("could not write the vidai-orient helper");
}

/// `bundle.macOS.minimumSystemVersion` of the core's configuration (the same helper build).
fn minimum_macos_version() -> String {
    let text = fs::read_to_string("../src-tauri/tauri.conf.json")
        .expect("could not read src-tauri/tauri.conf.json");
    let config: serde_json::Value =
        serde_json::from_str(&text).expect("src-tauri/tauri.conf.json is not valid JSON");
    config
        .pointer("/bundle/macOS/minimumSystemVersion")
        .and_then(serde_json::Value::as_str)
        .expect("src-tauri/tauri.conf.json must set bundle.macOS.minimumSystemVersion")
        .to_owned()
}

/// Release builds embed `../dist` (the UI, from `npm run build`): without it the build stops here
/// with the way out, instead of making a server that has no page. Debug builds read the folder
/// from disk and say so at run time.
fn check_ui() {
    if env::var("PROFILE").is_ok_and(|profile| profile == "release") {
        // Cargo then rebuilds the embedded files when the UI changes.
        println!("cargo:rerun-if-changed=../dist");
        if !Path::new("../dist/index.html").is_file() {
            panic!(
                "VidAI Web embeds the user interface from dist/, which is missing: \
                 run `npm run build` in the VidAI folder first (npm run web does both)"
            );
        }
    }
}

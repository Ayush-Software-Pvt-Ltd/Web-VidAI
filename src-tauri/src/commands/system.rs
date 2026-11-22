//! System commands: Claude Code status, models and usage, helper tools, opening files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::claude::service::ClaudeService;
use crate::claude::{auth, env, locate};
use crate::error::{AppError, AppResult};
use crate::model::{
    ClaudeInfo, ClaudeStatus, GitBashStatus, Platform, SystemStatus, ToolName, ToolStatus,
    UsageStatus,
};
use crate::platform;
use crate::store::Store;

/// The official Claude Code installer command (SPEC section 6; on Windows the PowerShell one of
/// section 11).
#[cfg(not(windows))]
pub const INSTALL_COMMAND: &str = "curl -fsSL https://claude.ai/install.sh | bash";
#[cfg(windows)]
pub const INSTALL_COMMAND: &str = "irm https://claude.ai/install.ps1 | iex";

/// Runs blocking work off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(format!("Background work failed: {e}")))
}

/// The platform and whether it is supported, Claude Code (installed, version, logged in), Git
/// Bash (Windows), the helper tools and the one-line summary of the computer. Always checks
/// afresh (no cache), so Check Again reflects the current state; only the machine facts are
/// probed once per run.
#[tauri::command]
#[specta::specta]
pub async fn check_system(app: AppHandle) -> AppResult<SystemStatus> {
    let app_version = app.package_info().version.to_string();
    blocking(move || {
        let env = env::child_env();
        let claude = match locate::find() {
            Some(bin) => ClaudeStatus {
                found: true,
                path: Some(bin.to_string_lossy().into_owned()),
                version: locate::version(&bin, &env),
                logged_in: auth::check_logged_in(&bin, &env).unwrap_or(false),
            },
            None => ClaudeStatus::default(),
        };
        let tools = [
            (ToolName::Ffmpeg, "ffmpeg"),
            (ToolName::Ffprobe, "ffprobe"),
            (ToolName::Python3, "python3"),
            (ToolName::Node, "node"),
        ]
        .into_iter()
        .map(|(name, exe)| {
            let path = locate::which_tool(exe, &env);
            ToolStatus {
                name,
                found: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect();
        SystemStatus {
            app_version,
            platform: Platform::current(),
            platform_supported: platform::platform_supported(),
            claude,
            git_bash: git_bash_status(&env),
            opencode2: crate::opencode::harness::locate2::status(),
            tools,
            machine: platform::machine::facts().summary(),
        }
    })
    .await
}

/// Git Bash on Windows (SPEC section 11, Prerequisites); `None` on macOS, which needs nothing
/// like it.
fn git_bash_status(env: &HashMap<String, String>) -> Option<GitBashStatus> {
    #[cfg(windows)]
    {
        let path = platform::windows::git_bash(env);
        Some(GitBashStatus {
            found: path.is_some(),
            path: path.map(|p| p.to_string_lossy().into_owned()),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = env;
        None
    }
}

/// Opens a terminal running `claude auth login`.
#[tauri::command]
#[specta::specta]
pub async fn open_claude_login(service: State<'_, ClaudeService>) -> AppResult<()> {
    let dir = service.helper_dir().to_path_buf();
    blocking(move || {
        let bin = locate::find().ok_or_else(AppError::claude_not_installed)?;
        let script = login_script(&bin, &env::child_env())?;
        platform::open_terminal_script(&dir, &script)
    })
    .await?
}

/// Opens a terminal that shows the official install command and runs it once the user presses
/// Return.
#[tauri::command]
#[specta::specta]
pub async fn open_claude_install(service: State<'_, ClaudeService>) -> AppResult<()> {
    let dir = service.helper_dir().to_path_buf();
    blocking(move || platform::open_terminal_script(&dir, &install_script())).await?
}

/// The model list and defaults, from the cache in `state.json` unless `refresh`.
#[tauri::command]
#[specta::specta]
pub async fn get_claude_info(app: AppHandle, refresh: bool) -> AppResult<ClaudeInfo> {
    if !refresh {
        return Ok(tauri::Manager::state::<Store>(&app)
            .claude_info()
            .unwrap_or_default());
    }
    blocking(move || tauri::Manager::state::<ClaudeService>(&app).refresh_info(&app)).await?
}

/// The plan's usage limits, cached unless `refresh`.
#[tauri::command]
#[specta::specta]
pub async fn get_usage(app: AppHandle, refresh: bool) -> AppResult<UsageStatus> {
    if !refresh {
        return Ok(tauri::Manager::state::<ClaudeService>(&app).usage());
    }
    blocking(move || tauri::Manager::state::<ClaudeService>(&app).refresh_usage(&app)).await
}

/// Single-quotes `text` for a POSIX shell.
#[cfg(not(windows))]
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[cfg(not(windows))]
fn login_script(bin: &Path, env: &HashMap<String, String>) -> AppResult<String> {
    let _ = env;
    Ok(format!(
        "echo 'Log in to Claude Code for VidAI'\n\
         echo\n\
         {} auth login\n\
         echo\n\
         echo 'You can close this window and return to VidAI.'",
        shell_quote(&bin.to_string_lossy())
    ))
}

/// The PowerShell version: `claude` is started the way VidAI starts it (`platform::launch`).
#[cfg(windows)]
fn login_script(bin: &Path, env: &HashMap<String, String>) -> AppResult<String> {
    use crate::platform::windows::ps_quote;
    let launch = crate::platform::launch::resolve(bin, env)
        .map_err(|e| AppError::internal(format!("Could not start Claude Code: {e}")))?;
    let mut call = format!("& {}", ps_quote(&launch.program.to_string_lossy()));
    for arg in &launch.args {
        call.push(' ');
        call.push_str(&ps_quote(&arg.to_string_lossy()));
    }
    Ok(format!(
        "Write-Host 'Log in to Claude Code for VidAI'\n\
         Write-Host ''\n\
         {call} auth login\n\
         Write-Host ''\n\
         Write-Host 'You can close this window and return to VidAI.'"
    ))
}

#[cfg(windows)]
fn install_script() -> String {
    format!(
        "Write-Host 'Install Claude Code for VidAI'\n\
         Write-Host ''\n\
         Write-Host 'This runs the official installer:'\n\
         Write-Host ''\n\
         Write-Host '    {INSTALL_COMMAND}'\n\
         Write-Host ''\n\
         Write-Host 'VidAI also needs Git for Windows: https://git-scm.com/downloads/win'\n\
         Write-Host ''\n\
         $null = Read-Host 'Press Enter to install, or close this window to cancel'\n\
         {INSTALL_COMMAND}\n\
         Write-Host ''\n\
         Write-Host 'When the installer has finished, return to VidAI and press Check Again.'"
    )
}

#[cfg(not(windows))]
fn install_script() -> String {
    format!(
        "echo 'Install Claude Code for VidAI'\n\
         echo\n\
         echo 'This runs the official installer:'\n\
         echo\n\
         echo '    {INSTALL_COMMAND}'\n\
         echo\n\
         printf 'Press Return to install, or close this window to cancel. '\n\
         read -r _ || exit 0\n\
         {INSTALL_COMMAND}\n\
         echo\n\
         echo 'When the installer has finished, return to VidAI and press Check Again.'"
    )
}

/// The terminal script of `open_opencode2_install` on this platform (`commands::opencode`).
pub(crate) fn opencode2_install_script() -> String {
    opencode2_install_script_for(cfg!(windows))
}

/// The script that shows the OpenCode 2 install command and runs it only after Return (Enter):
/// a shell script on a Mac, a PowerShell script on Windows (SPEC sections 7a and 11), like the
/// one of Claude Code. Both are compiled everywhere, so their tests run on every platform.
fn opencode2_install_script_for(windows: bool) -> String {
    use crate::opencode::harness::locate2::{INSTALL_COMMAND_MAC, INSTALL_COMMAND_WINDOWS};
    if windows {
        let command = INSTALL_COMMAND_WINDOWS;
        format!(
            "Write-Host 'Install OpenCode 2 for VidAI'\n\
             Write-Host ''\n\
             Write-Host 'This runs:'\n\
             Write-Host ''\n\
             Write-Host '    {command}'\n\
             Write-Host ''\n\
             $null = Read-Host 'Press Enter to install, or close this window to cancel'\n\
             {command}\n\
             Write-Host ''\n\
             Write-Host 'When the installer has finished, return to VidAI and press Check Again.'"
        )
    } else {
        let command = INSTALL_COMMAND_MAC;
        format!(
            "echo 'Install OpenCode 2 for VidAI'\n\
             echo\n\
             echo 'This runs the official installer:'\n\
             echo\n\
             echo '    {command}'\n\
             echo\n\
             printf 'Press Return to install, or close this window to cancel. '\n\
             read -r _ || exit 0\n\
             {command}\n\
             echo\n\
             echo 'When the installer has finished, return to VidAI and press Check Again.'"
        )
    }
}

fn existing_absolute(path: &str) -> AppResult<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(AppError::invalid_input(format!(
            "Not an absolute path: {}",
            path.display()
        )));
    }
    if !path.exists() {
        return Err(AppError::not_found(format!(
            "{} does not exist.",
            path.display()
        )));
    }
    Ok(path.to_path_buf())
}

/// Opens a file or folder with its default app.
#[tauri::command]
#[specta::specta]
pub async fn open_path(app: AppHandle, path: String) -> AppResult<()> {
    let path = existing_absolute(&path)?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::io(format!("Could not open {}: {e}", path.display())))
}

/// Shows a file or folder in Finder / Explorer.
#[tauri::command]
#[specta::specta]
pub async fn reveal_path(app: AppHandle, path: String) -> AppResult<()> {
    let path = existing_absolute(&path)?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::io(format!("Could not show {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::opencode::harness::locate2::{INSTALL_COMMAND_MAC, INSTALL_COMMAND_WINDOWS};

    #[test]
    fn path_validation() {
        assert_eq!(
            existing_absolute("relative").unwrap_err().code,
            ErrorCode::InvalidInput
        );
        let missing = std::env::temp_dir().join("definitely/not/here/vidai");
        assert_eq!(
            existing_absolute(missing.to_str().unwrap())
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let dir = tempfile::TempDir::new().unwrap();
        assert!(existing_absolute(dir.path().to_str().unwrap()).is_ok());
    }

    #[cfg(not(windows))]
    #[test]
    fn terminal_scripts() {
        let login = login_script(Path::new("/Users/a b/it's/claude"), &HashMap::new()).unwrap();
        assert!(login.contains("'/Users/a b/it'\\''s/claude' auth login\n"));
        let install = install_script();
        let read = install.find("read -r _").unwrap();
        let run = install.rfind(INSTALL_COMMAND).unwrap();
        assert!(read < run, "the installer runs only after Return");
        assert!(install.contains("echo '    curl -fsSL https://claude.ai/install.sh | bash'"));
    }

    #[cfg(windows)]
    #[test]
    fn terminal_scripts() {
        let login =
            login_script(Path::new(r"C:\Users\a b\it's\claude.exe"), &HashMap::new()).unwrap();
        assert!(login.contains(r"& 'C:\Users\a b\it''s\claude.exe' auth login"));
        let install = install_script();
        let read = install.find("Read-Host").unwrap();
        let run = install.rfind(INSTALL_COMMAND).unwrap();
        assert!(read < run, "the installer runs only after Enter");
        assert!(install.contains("Write-Host '    irm https://claude.ai/install.ps1 | iex'"));
    }

    #[test]
    fn opencode2_install_scripts_run_the_command_only_after_the_key() {
        let mac = opencode2_install_script_for(false);
        let read = mac.find("read -r _").unwrap();
        let run = mac.rfind(INSTALL_COMMAND_MAC).unwrap();
        assert!(read < run, "the installer runs only after Return");
        assert!(mac.contains("echo '    curl -fsSL https://opencode.ai/v2/install | bash'"));

        let windows = opencode2_install_script_for(true);
        let read = windows.find("Read-Host").unwrap();
        let run = windows.rfind(INSTALL_COMMAND_WINDOWS).unwrap();
        assert!(read < run, "the installer runs only after Enter");
        assert!(windows.contains("Write-Host '    winget install --id Anomaly.OpenCode --exact'"));
        assert!(windows.ends_with("press Check Again.'"));
        assert_eq!(
            opencode2_install_script(),
            if cfg!(windows) { windows } else { mac }
        );
    }
}

//! Backend commands (SPEC sections 4 and 7a): the key, address, model and reasoning effort of each
//! API option, "Edits run on" (`set_setup`), the model list, the Test request, the quota, the
//! routing note, and the OpenCode 2 program's status and installer. A key goes in through
//! `set_api_key` and never comes back out.
//!
//! Every command exists on every platform; nothing here is gated. `retry_secrets` also finishes
//! the key migration of a 0.2.4 install that was waiting for the keychain.

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_specta::Event;

use crate::claude::service::ClaudeService;
use crate::error::{AppError, AppResult};
use crate::events::SettingsChanged;
use crate::model::{
    API_EFFORTS, ApiKeyStatuses, ApiModels, ApiOption, ApiTest, ClaudeRouting, OpencodeCli,
    OpencodeUsage, Settings, Setup, now_iso,
};
use crate::opencode::{self, usage::UsageService};
use crate::secrets::Secrets;
use crate::store::Store;

/// Runs blocking work off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

/// Forgets the quota and asks again in the background (another key, address or provider).
fn refresh_usage_soon<R: Runtime>(app: &AppHandle<R>) {
    app.state::<UsageService>().reset();
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("vidai-opencode-usage-now".into())
        .spawn(move || {
            handle.state::<UsageService>().refresh(&handle);
        });
    if let Err(err) = spawned {
        eprintln!("vidai: could not refresh the OpenCode usage: {err}");
    }
}

/// Back to the Claude subscription when `option` cannot be selected any more (its key or model
/// was removed). Tells the UI, since no settings command of its own returns the change.
fn fall_back_to_claude<R: Runtime>(app: &AppHandle<R>, option: ApiOption) -> AppResult<()> {
    let store = app.state::<Store>();
    if store.settings().setup.api_option() != Some(option) {
        return Ok(());
    }
    let settings = store.update_settings(|s| {
        s.setup = Setup::ClaudeSubscription;
        Ok(s.clone())
    })?;
    if let Err(err) = SettingsChanged(settings).emit(app) {
        eprintln!("vidai: could not send the settings: {err}");
    }
    Ok(())
}

/// A model id as the settings keep it: trimmed, no spaces or control characters.
fn model_id(text: &str) -> AppResult<String> {
    let model = text.trim();
    if model.is_empty() || model.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::invalid_input("That is not a model id."));
    }
    Ok(model.to_owned())
}

#[tauri::command]
#[specta::specta]
pub async fn get_api_key_statuses(secrets: State<'_, Secrets>) -> AppResult<ApiKeyStatuses> {
    opencode::key_statuses(&secrets)
}

/// Saves the key of one option (trimmed, not empty) in the OS keychain (`secrets::Secrets`).
#[tauri::command]
#[specta::specta]
pub async fn set_api_key(
    app: AppHandle,
    secrets: State<'_, Secrets>,
    option: ApiOption,
    key: String,
) -> AppResult<ApiKeyStatuses> {
    let statuses = opencode::save_key(&secrets, option, &key)?;
    if option == ApiOption::OpencodeGo {
        refresh_usage_soon(&app);
    }
    Ok(statuses)
}

/// Removes the key of one option. While edits run on OpenCode Go they go back to the Claude
/// subscription; options 3 and 4 work without a key and stay selected.
#[tauri::command]
#[specta::specta]
pub async fn clear_api_key(
    app: AppHandle,
    secrets: State<'_, Secrets>,
    option: ApiOption,
) -> AppResult<ApiKeyStatuses> {
    let statuses = opencode::clear_key(&secrets, option)?;
    // Only an option that needs its key loses its selection with it.
    if option.key_required() {
        fall_back_to_claude(&app, option)?;
    }
    if option == ApiOption::OpencodeGo {
        refresh_usage_soon(&app);
    }
    Ok(statuses)
}

/// "Edits run on": the Claude subscription, or an API option (only with a saved key and a chosen
/// model). New edits use it; running jobs and the sessions of earlier edits keep theirs. The
/// program is not checked here: a missing one is a readiness problem (SPEC section 6).
#[tauri::command]
#[specta::specta]
pub async fn set_setup(app: AppHandle, setup: Setup) -> AppResult<Settings> {
    if let Some(option) = setup.api_option() {
        let api = opencode::current_api_setup(&app, option)?;
        if let Some(problem) = api.selection_problem() {
            return Err(AppError::invalid_input(problem));
        }
    }
    let store = app.state::<Store>();
    let changed = store.settings().setup != setup;
    let settings = store.update_settings(|s| {
        s.setup = setup;
        Ok(s.clone())
    })?;
    if changed {
        refresh_quotas_soon(&app, setup);
    }
    Ok(settings)
}

/// Refreshes the meters of the setup that is now selected: the OpenCode Go quota, or the Claude
/// meters (not refreshed while edits ran elsewhere).
fn refresh_quotas_soon<R: Runtime>(app: &AppHandle<R>, setup: Setup) {
    match setup {
        Setup::OpencodeGo => refresh_usage_soon(app),
        Setup::ClaudeSubscription => {
            let handle = app.clone();
            let _ = std::thread::Builder::new()
                .name("vidai-claude-usage-now".into())
                .spawn(move || {
                    let service = handle.state::<ClaudeService>();
                    service.refresh_usage(&handle);
                    // The model list was not kept fresh while another setup edited.
                    let _ = service.refresh_info(&handle);
                });
        }
        Setup::AnthropicApi | Setup::OpenaiApi => {}
    }
}

/// Sets the address of one option (`null` or empty: its default). It is normalized by the rules of
/// the option's protocol (`opencode::normalize_base_url`); one that cannot be used is refused.
#[tauri::command]
#[specta::specta]
pub async fn set_api_base_url(
    app: AppHandle,
    option: ApiOption,
    base_url: Option<String>,
) -> AppResult<Settings> {
    let normalized = match base_url.as_deref() {
        Some(text) => opencode::normalize_base_url(option, text)?,
        None => None,
    };
    let store = app.state::<Store>();
    let changed = store.settings().api_options.get(option).base_url != normalized;
    let settings = store.update_settings(|s| {
        s.api_options.get_mut(option).base_url = normalized;
        Ok(s.clone())
    })?;
    if changed && option == ApiOption::OpencodeGo {
        refresh_usage_soon(&app);
    }
    Ok(settings)
}

/// Chooses the model of one option (`null` clears it; on the selected option edits then go back
/// to the Claude subscription).
#[tauri::command]
#[specta::specta]
pub async fn set_api_model(
    app: AppHandle,
    option: ApiOption,
    model: Option<String>,
) -> AppResult<Settings> {
    let model = match model.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(text) => Some(model_id(text)?),
    };
    let store = app.state::<Store>();
    store.update_settings(|s| {
        s.api_options.get_mut(option).model = model.clone();
        if model.is_none() && s.setup.api_option() == Some(option) {
            s.setup = Setup::ClaudeSubscription;
        }
        Ok(s.clone())
    })
}

/// Remembers the reasoning effort of one model of one option (`null` forgets it: the model runs
/// on its own default). Other models keep theirs, so switching models back restores each effort.
#[tauri::command]
#[specta::specta]
pub async fn set_api_effort(
    app: AppHandle,
    option: ApiOption,
    model: String,
    effort: Option<String>,
) -> AppResult<Settings> {
    let model = model_id(&model)?;
    if let Some(effort) = &effort
        && !API_EFFORTS.contains(&effort.as_str())
    {
        return Err(AppError::invalid_input(format!(
            "The reasoning effort must be one of: {}.",
            API_EFFORTS.join(", ")
        )));
    }
    app.state::<Store>().update_settings(|s| {
        let efforts = &mut s.api_options.get_mut(option).efforts;
        match &effort {
            Some(effort) => efforts.insert(model.clone(), effort.clone()),
            None => efforts.remove(&model),
        };
        Ok(s.clone())
    })
}

/// The OpenCode v2 program (`opencode2`) on this computer: found, where, its version, and whether
/// VidAI drives it. Always checks afresh.
#[tauri::command]
#[specta::specta]
pub async fn get_opencode2_cli() -> AppResult<OpencodeCli> {
    blocking(|| Ok(opencode::harness::locate2::status())).await
}

/// Opens a terminal (Terminal on a Mac, PowerShell on Windows) that shows the OpenCode 2 install
/// command and runs it once the user presses Return (Enter).
#[tauri::command]
#[specta::specta]
pub async fn open_opencode2_install(service: State<'_, ClaudeService>) -> AppResult<()> {
    let dir = service.helper_dir().to_path_buf();
    blocking(move || {
        crate::platform::open_terminal_script(&dir, &super::system::opencode2_install_script())
    })
    .await
}

/// The models of one option at its address: the cached list unless `refresh`, then live from the
/// list address of the option's protocol (with the saved key when there is one), cached in
/// `state.json`. Only OpenCode Go keeps the list; for the other options (a typed model, a list
/// fetched on demand) the answer is returned and not kept.
#[tauri::command]
#[specta::specta]
pub async fn get_api_models(
    app: AppHandle,
    option: ApiOption,
    refresh: bool,
) -> AppResult<ApiModels> {
    let store = app.state::<Store>();
    let base_url = opencode::base_url(&store.settings(), option);
    if !refresh {
        return Ok(store
            .api_models(option)
            .filter(|m| m.base_url == base_url)
            .unwrap_or(ApiModels {
                option,
                base_url,
                models: Vec::new(),
                fetched_at: None,
            }));
    }
    // While the saved keys cannot be read, the public list is asked (OpenCode Go has one).
    let key = opencode::saved_key(app.state::<Secrets>().inner(), option).unwrap_or(None);
    let models = opencode::http::fetch_models(option, &base_url, key.as_deref())
        .await
        .map_err(|err| AppError::internal(opencode::scrub(&err.message, key.as_deref())))?;
    let list = ApiModels {
        option,
        base_url,
        models,
        fetched_at: Some(now_iso()),
    };
    if option == ApiOption::OpencodeGo {
        let saved = list.clone();
        blocking(move || app.state::<Store>().set_api_models(saved)).await?;
    }
    Ok(list)
}

/// Sends one tiny request to the option's service (its protocol's message request, `max_tokens`
/// 1, the chosen model) and says whether the key, the plan and the model work together.
#[tauri::command]
#[specta::specta]
pub async fn test_api(app: AppHandle, option: ApiOption) -> AppResult<ApiTest> {
    let setup = opencode::current_api_setup(&app, option)?;
    // Options 3 and 4 work without a key; only OpenCode Go needs one.
    if setup.key.is_none() && option.key_required() {
        return Err(AppError::invalid_input(
            "No API key is saved for this option. Save a key first.",
        ));
    }
    let Some(model) = setup.model.as_deref() else {
        return Err(AppError::invalid_input(opencode::no_model_text(option)));
    };
    let name = app
        .state::<Store>()
        .api_models(option)
        .and_then(|list| {
            list.models
                .into_iter()
                .find(|m| m.id == model)
                .map(|m| m.display_name)
        })
        .unwrap_or_else(|| model.to_owned());
    Ok(opencode::http::test(option, &setup.base_url, setup.key.as_deref(), model, &name).await)
}

/// The OpenCode quota, cached unless `refresh`.
#[tauri::command]
#[specta::specta]
pub async fn get_opencode_usage(app: AppHandle, refresh: bool) -> AppResult<OpencodeUsage> {
    if !refresh {
        return Ok(app.state::<UsageService>().usage());
    }
    blocking(move || Ok(app.state::<UsageService>().refresh(&app))).await
}

/// Where the user's own setup points Claude Code at another service, if it does.
#[tauri::command]
#[specta::specta]
pub async fn get_claude_routing() -> AppResult<Option<ClaudeRouting>> {
    blocking(|| Ok(opencode::routing::detect())).await
}

/// Reads the saved API keys again after the startup read failed (the Keychain dialog was denied
/// or the Keychain was locked). The only read besides the one at startup.
#[tauri::command]
#[specta::specta]
pub async fn retry_secrets(app: AppHandle, secrets: State<'_, Secrets>) -> AppResult<()> {
    let secrets = secrets.inner().clone();
    {
        let secrets = secrets.clone();
        blocking(move || secrets.retry()).await?;
    }
    // The keys can be read now: a pending key migration (SPEC section 7a) can finish.
    let finishing = (app.clone(), secrets.clone());
    blocking(move || {
        crate::secrets::finish_key_migration(&finishing.0.state::<Store>(), &finishing.1)
    })
    .await?;
    refresh_usage_soon(&app);
    Ok(())
}

//! The API options and the OpenCode 2 program (SPEC section 7a, "Harness + API Keys").
//!
//! Three of the four setups use a service with an API key, an address, a model and reasoning
//! efforts of their own (`model::ApiOption`); this module is where their addresses, keys and
//! launch facts live:
//!
//! - The address: [`default_base_url`], [`normalize_base_url`] (by the protocol of the option) and
//!   [`base_url`].
//! - The key: [`saved_key`], [`key_status`], [`key_statuses`], [`save_key`], [`clear_key`] (the
//!   keychain through `secrets`, one field per option); a key never reaches the UI, a log,
//!   `state.json` or an error message.
//! - Jobs: [`job_env`] (the variables of `anthropicApi`) and [`ApiSetup`], what selecting an
//!   option and launching a job on it need to know.
//! - [`http`]: the model list, the Test request and the quota request per option, and the
//!   readable texts for what a service answers. [`usage`]: the OpenCode Go quota shown in the top
//!   bar. [`routing`]: whether the user's own setup already points Claude Code somewhere else.
//! - [`harness`]: the OpenCode 2 program.
//! - [`keeps_jobs_going`]: where jobs keep themselves going.

pub mod harness;
pub mod http;
pub mod routing;
pub mod usage;

use std::collections::HashMap;

use crate::error::{AppError, AppResult};
use crate::model::{ApiKeyStatus, ApiKeyStatuses, ApiModels, ApiOption, Settings};
use crate::secrets::Secrets;

/// Whether a running job keeps itself going when a turn ends before its work is done (SPEC
/// section 6, "Keeping a job going"), for jobs on every setup. Nothing about it depends on the
/// platform: it needs only the turns of the model and the files the job writes, so it applies on
/// every platform VidAI runs on.
pub fn keeps_jobs_going() -> bool {
    true
}

/// The default address of `opencodeGo`: an OpenCode Go subscription (Anthropic's form).
pub const DEFAULT_BASE_URL: &str = "https://opencode.ai/inference/go/anthropic";
/// The default address of `anthropicApi`.
pub const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// The default address of `openaiApi` (OpenAI's form, which keeps its `/v1`).
pub const OPENAI_DEFAULT_BASE_URL: &str = "https://opencode.ai/inference/go/v1";
/// The address of OpenCode's pay-as-you-go balance.
pub const PAY_AS_YOU_GO_BASE_URL: &str = "https://opencode.ai/inference/anthropic";
/// Where the user manages keys, plans, budgets and sees usage.
pub const CONSOLE_URL: &str = "https://opencode.ai/console";

/// The variables that point a job's Claude Code at an Anthropic compatible API (`anthropicApi`):
/// the address, the key (sent as `x-api-key`), and the model behind each of Claude Code's model
/// aliases (used by `/model`, sub-agents and background tasks), all set to the one chosen model.
pub const ENV_VARS: [&str; 5] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];
/// The variable of the user's own environment that is removed from the job's when the job has a
/// key, so no token of the user's ever competes with the key. Without a key it carries
/// [`NO_KEY_TOKEN`] instead.
pub const REMOVED_ENV_VAR: &str = "ANTHROPIC_AUTH_TOKEN";
/// What Claude Code is given as its token when `anthropicApi` has no key (a server on this
/// computer often needs none). Claude Code uses `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization:
/// Bearer`) ahead of the user's Claude login, so a job never falls back to the subscription or
/// asks for a login, and the requests still go to the base URL. It is no secret, and a server
/// that needs no key ignores it.
pub const NO_KEY_TOKEN: &str = "no-key";

/// Replacement text for an API key in logs.
pub const SCRUBBED: &str = "[api key]";

// ---------------------------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------------------------

/// The default address of `option` (stored as `null`).
pub fn default_base_url(option: ApiOption) -> &'static str {
    match option {
        ApiOption::OpencodeGo => DEFAULT_BASE_URL,
        ApiOption::AnthropicApi => ANTHROPIC_DEFAULT_BASE_URL,
        ApiOption::OpenaiApi => OPENAI_DEFAULT_BASE_URL,
    }
}

/// Checks and normalizes an address typed into Settings for `option`. `Ok(None)` means the
/// default address of the option.
///
/// Accepted: `https://` anywhere, plain `http://` only for this computer (`localhost`,
/// `127.0.0.1`, `[::1]`). No user name or password, query or fragment. A pasted trailing `/` is
/// removed. By the protocol of the option: the Anthropic form (`opencodeGo`, `anthropicApi`) also
/// drops a trailing `/v1/messages` or `/v1`, because Claude Code and OpenCode 2 append
/// `/v1/messages` themselves; the OpenAI form (`openaiApi`) drops a trailing `/chat/completions`
/// and keeps `/v1`, because it is part of the address.
pub fn normalize_base_url(option: ApiOption, text: &str) -> AppResult<Option<String>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let invalid = || {
        AppError::invalid_input(format!(
            "Enter an address that starts with https://, for example {}.",
            default_base_url(option)
        ))
    };
    let url = reqwest::Url::parse(text).map_err(|_| invalid())?;
    let host = url.host_str().ok_or_else(invalid)?.to_ascii_lowercase();
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&host) => {}
        "http" => {
            return Err(AppError::invalid_input(
                "Use https:// for the address. Plain http:// is only allowed for an address on this computer (localhost).",
            ));
        }
        _ => return Err(invalid()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::invalid_input(
            "Leave the user name and password out of the address; VidAI sends the API key itself.",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AppError::invalid_input(
            "The address cannot contain a ? or # part.",
        ));
    }
    let suffixes: &[&str] = match option {
        ApiOption::OpencodeGo | ApiOption::AnthropicApi => &["/v1/messages", "/v1"],
        ApiOption::OpenaiApi => &["/chat/completions"],
    };
    let mut path = url.path().trim_end_matches('/').to_owned();
    for suffix in suffixes {
        if path.to_ascii_lowercase().ends_with(suffix) {
            path.truncate(path.len() - suffix.len());
            path = path.trim_end_matches('/').to_owned();
        }
    }
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };
    let normalized = format!("{}://{host}{port}{path}", url.scheme());
    Ok((normalized != default_base_url(option)).then_some(normalized))
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// The address edits and requests of `option` use: the saved one, or its default.
pub fn base_url(settings: &Settings, option: ApiOption) -> String {
    settings
        .api_options
        .get(option)
        .base_url
        .clone()
        .unwrap_or_else(|| default_base_url(option).to_owned())
}

// ---------------------------------------------------------------------------------------------
// The keys
// ---------------------------------------------------------------------------------------------

/// The saved key of `option`, if any (Settings is its only source).
pub fn saved_key(secrets: &Secrets, option: ApiOption) -> AppResult<Option<String>> {
    Ok(secrets
        .get(crate::secrets::key_name(option))?
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty()))
}

/// Every saved key (for the log scrubber). Fails with `secretsUnavailable` while the saved keys
/// cannot be read.
pub fn saved_keys(secrets: &Secrets) -> AppResult<Vec<String>> {
    let mut keys = Vec::new();
    for option in ApiOption::ALL {
        keys.extend(saved_key(secrets, option)?);
    }
    Ok(keys)
}

/// `"...9f2c"` for a key ending in `9f2c`. Short keys only show the dots.
pub fn key_hint(key: &str) -> String {
    let chars: Vec<char> = key.trim().chars().collect();
    if chars.len() < 8 {
        return "...".into();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("...{tail}")
}

/// What the UI may know about the saved key of `option`.
pub fn key_status(secrets: &Secrets, option: ApiOption) -> AppResult<ApiKeyStatus> {
    Ok(match saved_key(secrets, option)? {
        Some(key) => ApiKeyStatus {
            configured: true,
            key_hint: Some(key_hint(&key)),
        },
        None => ApiKeyStatus::default(),
    })
}

/// What the UI may know about the saved key of every option.
pub fn key_statuses(secrets: &Secrets) -> AppResult<ApiKeyStatuses> {
    let mut statuses = ApiKeyStatuses::default();
    for option in ApiOption::ALL {
        *statuses.get_mut(option) = key_status(secrets, option)?;
    }
    Ok(statuses)
}

/// Trims and checks a key typed into Settings.
pub fn normalize_key(key: &str) -> AppResult<String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::invalid_input("Enter an API key."));
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::invalid_input(
            "An API key has no spaces or line breaks. Copy it again and paste only the key.",
        ));
    }
    Ok(key.to_owned())
}

/// Saves the key of `option` (trimmed) and returns the statuses of all three.
pub fn save_key(secrets: &Secrets, option: ApiOption, key: &str) -> AppResult<ApiKeyStatuses> {
    let key = normalize_key(key)?;
    secrets.set(crate::secrets::key_name(option), &key)?;
    key_statuses(secrets)
}

/// Removes the saved key of `option` and returns the statuses of all three.
pub fn clear_key(secrets: &Secrets, option: ApiOption) -> AppResult<ApiKeyStatuses> {
    secrets.delete(crate::secrets::key_name(option))?;
    key_statuses(secrets)
}

/// `text` with the key replaced by [`SCRUBBED`].
pub fn scrub(text: &str, key: Option<&str>) -> String {
    match key.map(str::trim) {
        Some(key) if !key.is_empty() => text.replace(key, SCRUBBED),
        _ => text.to_owned(),
    }
}

// ---------------------------------------------------------------------------------------------
// Selecting an option, and what a job needs
// ---------------------------------------------------------------------------------------------

/// What VidAI knows about one API option right now, for selecting it and for launching a job.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiSetup {
    pub option: ApiOption,
    pub key: Option<String>,
    /// The normalized address (the default when the option has none of its own).
    pub base_url: String,
    /// The model chosen in Settings.
    pub model: Option<String>,
    /// The model ids last fetched for `base_url`, `None` when no list was fetched for it. Only
    /// OpenCode Go keeps a list; `anthropicApi` and `openaiApi` take any typed model, so theirs
    /// is always `None`.
    pub offered: Option<Vec<String>>,
}

impl std::fmt::Debug for ApiSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiSetup")
            .field("option", &self.option)
            .field("key", &self.key.as_ref().map(|_| SCRUBBED))
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

impl ApiSetup {
    /// From the settings, the saved key and the cached model list of `option` (`None` for the
    /// options without a kept list).
    pub fn new(
        option: ApiOption,
        settings: &Settings,
        key: Option<String>,
        models: Option<&ApiModels>,
    ) -> Self {
        let base_url = base_url(settings, option);
        let offered = models
            .filter(|m| m.option == option && m.base_url == base_url && m.fetched_at.is_some())
            .map(|m| m.models.iter().map(|m| m.id.clone()).collect());
        Self {
            option,
            key,
            base_url,
            model: settings.api_options.get(option).model.clone(),
            offered,
        }
    }

    /// The service of this option, as the texts say it.
    fn service(&self) -> &'static str {
        self.option.setup().service_name()
    }

    /// Why a job cannot run on this option with `model`, or `None` when it can. The model counts
    /// as gone only when the last list fetched for this address (OpenCode Go only) does not have
    /// it; a model typed for another option is never refused for missing from a list.
    pub fn problem_with(&self, model: Option<&str>) -> Option<String> {
        if self.key.is_none() && self.option.key_required() {
            return Some(format!("No API key is saved for {}.", self.service()));
        }
        let Some(model) = model.filter(|m| !m.trim().is_empty()) else {
            return Some(format!("No model is chosen for {}.", self.service()));
        };
        if let Some(offered) = &self.offered
            && !offered.iter().any(|m| m == model)
        {
            return Some(format!(
                "{} no longer offers the model {model}.",
                self.service()
            ));
        }
        None
    }

    /// Why this option cannot be selected for new edits, or `None` when it can (`set_setup`).
    pub fn selection_problem(&self) -> Option<String> {
        let needs_key = self.key.is_none() && self.option.key_required();
        match (needs_key, &self.model) {
            (true, None) => Some("Save an API key and choose a model first.".into()),
            (true, Some(_)) => Some("Save an API key first.".into()),
            (false, None) => Some(no_model_text(self.option).into()),
            (false, Some(_)) => None,
        }
    }
}

/// What an option without a model says: OpenCode Go's model is chosen from its list, the model of
/// options 3 and 4 is typed (SPEC section 9, Settings).
pub fn no_model_text(option: ApiOption) -> &'static str {
    if option.key_required() {
        "Choose a model first."
    } else {
        "Type a model first."
    }
}

/// The [`ApiSetup`] of `option` in the running app: the settings, the saved key and the cached
/// model list. Fails with `secretsUnavailable` while the saved keys cannot be read.
pub fn current_api_setup<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    option: ApiOption,
) -> AppResult<ApiSetup> {
    use tauri::Manager;
    let store = app.state::<crate::store::Store>();
    let key = saved_key(app.state::<Secrets>().inner(), option)?;
    Ok(ApiSetup::new(
        option,
        &store.settings(),
        key,
        store.api_models(option).as_ref(),
    ))
}

/// Sets the [`ENV_VARS`] in the environment of a job's Claude Code process that runs on
/// `anthropicApi`. With a key, [`REMOVED_ENV_VAR`] is removed and the key is `ANTHROPIC_API_KEY`.
/// Without one (the option's key is optional), `ANTHROPIC_API_KEY` is removed, so the user's own
/// never leaks to the server, and `ANTHROPIC_AUTH_TOKEN` is [`NO_KEY_TOKEN`], so Claude Code does
/// not use the user's Claude login. Nothing else is changed. A job on the Claude subscription
/// never calls this, so its environment stays exactly the user's.
pub fn job_env(env: &mut HashMap<String, String>, base_url: &str, key: Option<&str>, model: &str) {
    let [base, api_key, opus, sonnet, haiku] = ENV_VARS;
    match key {
        Some(key) => {
            env.remove(REMOVED_ENV_VAR);
            env.insert(api_key.to_owned(), key.to_owned());
        }
        None => {
            env.remove(api_key);
            env.insert(REMOVED_ENV_VAR.to_owned(), NO_KEY_TOKEN.to_owned());
        }
    }
    env.insert(base.to_owned(), base_url.to_owned());
    for alias in [opus, sonnet, haiku] {
        env.insert(alias.to_owned(), model.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ApiModel;
    use crate::secrets::MemorySecretStore;
    use std::sync::Arc;

    fn go(text: &str) -> Option<String> {
        normalize_base_url(ApiOption::OpencodeGo, text).unwrap()
    }

    #[test]
    fn go_addresses_are_normalized() {
        assert_eq!(go(""), None);
        assert_eq!(go(DEFAULT_BASE_URL), None, "the default is stored as null");
        assert_eq!(go("https://opencode.ai/inference/go/anthropic/"), None);
        assert_eq!(
            go("  https://opencode.ai/inference/go/anthropic/v1/messages "),
            None
        );
        assert_eq!(
            go("https://OpenCode.AI/inference/anthropic/V1/"),
            Some(PAY_AS_YOU_GO_BASE_URL.to_owned())
        );
        assert_eq!(
            go("http://127.0.0.1:8484/inference/go/anthropic/v1/messages/"),
            Some("http://127.0.0.1:8484/inference/go/anthropic".to_owned())
        );
        assert_eq!(
            go("http://localhost:9000"),
            Some("http://localhost:9000".to_owned())
        );
        assert_eq!(
            go("http://[::1]:9000/x"),
            Some("http://[::1]:9000/x".to_owned())
        );
        assert_eq!(
            go("https://gateway.example.com:8443/anthropic"),
            Some("https://gateway.example.com:8443/anthropic".to_owned())
        );
    }

    #[test]
    fn each_option_has_its_own_default_and_form() {
        let anthropic = |text: &str| normalize_base_url(ApiOption::AnthropicApi, text).unwrap();
        assert_eq!(anthropic(""), None);
        assert_eq!(anthropic("https://api.anthropic.com/"), None);
        assert_eq!(anthropic("https://api.anthropic.com/v1"), None);
        assert_eq!(anthropic("https://api.anthropic.com/v1/messages"), None);
        assert_eq!(
            anthropic(DEFAULT_BASE_URL),
            Some(DEFAULT_BASE_URL.to_owned()),
            "the Go address is not the default of anthropicApi"
        );
        assert_eq!(
            anthropic("https://gw.example.com/anthropic/v1/"),
            Some("https://gw.example.com/anthropic".to_owned())
        );

        let openai = |text: &str| normalize_base_url(ApiOption::OpenaiApi, text).unwrap();
        assert_eq!(openai(""), None);
        assert_eq!(openai("https://opencode.ai/inference/go/v1/"), None);
        assert_eq!(
            openai("https://opencode.ai/inference/go/v1/chat/completions"),
            None
        );
        assert_eq!(
            openai("https://api.openai.com/v1/chat/completions/"),
            Some("https://api.openai.com/v1".to_owned()),
            "the /v1 is kept"
        );
        assert_eq!(
            openai("https://api.openai.com/v1"),
            Some("https://api.openai.com/v1".to_owned())
        );
        assert_eq!(
            openai("https://api.openai.com"),
            Some("https://api.openai.com".to_owned())
        );
        assert_eq!(
            openai("http://localhost:11434/v1"),
            Some("http://localhost:11434/v1".to_owned())
        );
        assert_eq!(
            default_base_url(ApiOption::AnthropicApi),
            "https://api.anthropic.com"
        );
    }

    #[test]
    fn bad_addresses_are_refused_for_every_option() {
        for option in ApiOption::ALL {
            for (text, says) in [
                ("http://opencode.ai/inference/anthropic", "Plain http://"),
                ("ftp://opencode.ai", "https://"),
                ("opencode.ai/inference", "https://"),
                ("https://user:pass@opencode.ai/x", "user name"),
                ("https://opencode.ai/x?key=1", "? or #"),
                ("https://opencode.ai/x#a", "? or #"),
            ] {
                let err = normalize_base_url(option, text).unwrap_err();
                assert_eq!(err.code, crate::error::ErrorCode::InvalidInput, "{text}");
                assert!(err.message.contains(says), "{text}: {}", err.message);
            }
        }
    }

    #[test]
    fn the_address_of_an_option_is_its_saved_one_or_its_default() {
        let mut settings = Settings::default();
        assert_eq!(
            base_url(&settings, ApiOption::AnthropicApi),
            "https://api.anthropic.com"
        );
        assert_eq!(
            base_url(&settings, ApiOption::OpenaiApi),
            OPENAI_DEFAULT_BASE_URL
        );
        settings.api_options.openai_api.base_url = Some("https://x.example/v1".into());
        assert_eq!(
            base_url(&settings, ApiOption::OpenaiApi),
            "https://x.example/v1"
        );
        assert_eq!(base_url(&settings, ApiOption::OpencodeGo), DEFAULT_BASE_URL);
    }

    #[test]
    fn key_status_set_and_clear_per_option() {
        let secrets = Secrets::new(Arc::new(MemorySecretStore::default()));
        assert_eq!(key_statuses(&secrets).unwrap(), ApiKeyStatuses::default());
        let saved = save_key(
            &secrets,
            ApiOption::AnthropicApi,
            " sk-ant-abcdefgh1234wxyz\n",
        )
        .unwrap();
        assert!(saved.anthropic_api.configured);
        assert_eq!(saved.anthropic_api.key_hint.as_deref(), Some("...wxyz"));
        assert!(!saved.opencode_go.configured && !saved.openai_api.configured);
        let json = serde_json::to_string(&saved).unwrap();
        assert!(!json.contains("abcdefgh"), "{json}");
        for bad in ["", "  ", "oc sk"] {
            assert!(
                save_key(&secrets, ApiOption::OpenaiApi, bad).is_err(),
                "{bad:?}"
            );
        }
        save_key(&secrets, ApiOption::OpencodeGo, "oc_sk_go_9999").unwrap();
        assert_eq!(
            saved_key(&secrets, ApiOption::OpencodeGo)
                .unwrap()
                .as_deref(),
            Some("oc_sk_go_9999")
        );
        assert_eq!(
            saved_keys(&secrets).unwrap(),
            ["oc_sk_go_9999", "sk-ant-abcdefgh1234wxyz"]
        );
        let cleared = clear_key(&secrets, ApiOption::AnthropicApi).unwrap();
        assert!(!cleared.anthropic_api.configured && cleared.opencode_go.configured);
    }

    #[test]
    fn the_job_environment_has_exactly_the_five_variables_and_loses_the_token() {
        let mut env = HashMap::from([
            ("PATH".to_owned(), "/bin".to_owned()),
            ("ANTHROPIC_AUTH_TOKEN".to_owned(), "users-own".to_owned()),
        ]);
        job_env(
            &mut env,
            "https://api.anthropic.com",
            Some("sk-ant-k"),
            "claude-sonnet-5-5",
        );
        assert_eq!(env.len(), 6);
        assert_eq!(env["ANTHROPIC_BASE_URL"], "https://api.anthropic.com");
        assert_eq!(env["ANTHROPIC_API_KEY"], "sk-ant-k");
        assert!(!env.contains_key("ANTHROPIC_AUTH_TOKEN"));
        for alias in &ENV_VARS[2..] {
            assert_eq!(env[*alias], "claude-sonnet-5-5");
        }
        assert_eq!(env["PATH"], "/bin");
    }

    #[test]
    fn without_a_key_the_job_environment_has_a_placeholder_token_and_no_key_of_the_users() {
        let mut env = HashMap::from([
            ("PATH".to_owned(), "/bin".to_owned()),
            ("ANTHROPIC_API_KEY".to_owned(), "users-own-key".to_owned()),
            ("ANTHROPIC_AUTH_TOKEN".to_owned(), "users-own".to_owned()),
        ]);
        job_env(&mut env, "http://localhost:1234", None, "local-model");
        assert_eq!(env.len(), 6);
        assert_eq!(env["ANTHROPIC_BASE_URL"], "http://localhost:1234");
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], NO_KEY_TOKEN);
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        for alias in &ENV_VARS[2..] {
            assert_eq!(env[*alias], "local-model");
        }
    }

    #[test]
    fn hint_shows_last_four_only() {
        assert_eq!(key_hint("oc_live_1234567899f2c"), "...9f2c");
        assert_eq!(key_hint("short"), "...");
    }

    #[test]
    fn scrub_hides_the_key() {
        assert_eq!(
            scrub("Bearer oc_sk_1 and oc_sk_1", Some("oc_sk_1")),
            "Bearer [api key] and [api key]"
        );
        assert_eq!(scrub("x", None), "x");
    }

    fn setup(key: bool, model: Option<&str>, offered: Option<&[&str]>) -> ApiSetup {
        let mut settings = Settings::default();
        settings.api_options.opencode_go.model = model.map(Into::into);
        let models = offered.map(|ids| ApiModels {
            option: ApiOption::OpencodeGo,
            base_url: DEFAULT_BASE_URL.into(),
            models: ids
                .iter()
                .map(|id| ApiModel {
                    id: (*id).into(),
                    display_name: (*id).into(),
                })
                .collect(),
            fetched_at: Some("2026-11-15T10:00:00.000Z".into()),
        });
        ApiSetup::new(
            ApiOption::OpencodeGo,
            &settings,
            key.then(|| "oc_sk_x".to_owned()),
            models.as_ref(),
        )
    }

    #[test]
    fn what_a_launch_and_the_switch_need() {
        assert_eq!(
            setup(true, Some("glm-5.3"), None).problem_with(Some("glm-5.3")),
            None
        );
        assert!(
            setup(false, Some("glm-5.3"), None)
                .problem_with(Some("glm-5.3"))
                .unwrap()
                .contains("No API key is saved for OpenCode Go")
        );
        assert!(
            setup(true, None, None)
                .problem_with(None)
                .unwrap()
                .contains("No model is chosen")
        );
        assert!(
            setup(true, Some("a"), Some(&["b"]))
                .problem_with(Some("a"))
                .unwrap()
                .contains("no longer offers the model a")
        );
        assert_eq!(
            setup(true, Some("a"), Some(&["a", "b"])).problem_with(Some("a")),
            None
        );

        assert_eq!(setup(true, Some("a"), None).selection_problem(), None);
        assert_eq!(
            setup(false, None, None).selection_problem().unwrap(),
            "Save an API key and choose a model first."
        );
        assert_eq!(
            setup(true, None, None).selection_problem().unwrap(),
            "Choose a model first."
        );
        assert!(!format!("{:?}", setup(true, None, None)).contains("oc_sk_x"));
    }

    #[test]
    fn the_key_is_optional_on_options_3_and_4_only() {
        let keyless = |option: ApiOption, model: Option<&str>| {
            let mut settings = Settings::default();
            settings.api_options.get_mut(option).model = model.map(Into::into);
            ApiSetup::new(option, &settings, None, None)
        };
        for option in [ApiOption::AnthropicApi, ApiOption::OpenaiApi] {
            assert_eq!(keyless(option, Some("m")).problem_with(Some("m")), None);
            assert_eq!(keyless(option, Some("m")).selection_problem(), None);
            assert_eq!(
                keyless(option, None).selection_problem().unwrap(),
                "Type a model first."
            );
            assert!(
                keyless(option, None)
                    .problem_with(None)
                    .unwrap()
                    .contains("No model is chosen")
            );
        }
        let go = keyless(ApiOption::OpencodeGo, Some("m"));
        assert!(go.problem_with(Some("m")).unwrap().contains("No API key"));
        assert_eq!(go.selection_problem().unwrap(), "Save an API key first.");
    }

    #[test]
    fn a_list_of_another_address_or_option_says_nothing_about_the_model() {
        let mut settings = Settings::default();
        settings.api_options.opencode_go.model = Some("a".into());
        let mut other = ApiModels {
            option: ApiOption::OpencodeGo,
            base_url: PAY_AS_YOU_GO_BASE_URL.into(),
            models: vec![],
            fetched_at: Some("2026-11-15T10:00:00.000Z".into()),
        };
        let setup = ApiSetup::new(
            ApiOption::OpencodeGo,
            &settings,
            Some("k".into()),
            Some(&other),
        );
        assert_eq!(setup.offered, None);
        assert_eq!(setup.problem_with(Some("a")), None);
        other.base_url = DEFAULT_BASE_URL.into();
        other.option = ApiOption::AnthropicApi;
        let setup = ApiSetup::new(
            ApiOption::OpencodeGo,
            &settings,
            Some("k".into()),
            Some(&other),
        );
        assert_eq!(setup.offered, None);
    }
}

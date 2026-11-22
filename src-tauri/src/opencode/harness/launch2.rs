//! What one OpenCode 2 server of a job is started with (SPEC section 7a, "The OpenCode 2
//! program"): the command line, the environment, the per-run configuration, how VidAI's address
//! and model become OpenCode 2's `provider/model`, and the permissions of its session.
//!
//! Nothing is written to a file: the configuration goes in `OPENCODE_CONFIG_CONTENT`, which
//! OpenCode 2 merges over the user's own configuration (above every configuration file of the
//! user, below an administrator's managed settings), and the key goes in the variable of the
//! option: `OPENCODE_API_KEY` for `opencodeGo`, `VIDAI_API_KEY` for `openaiApi`.
//!
//! - The configuration has OpenCode 2's own keys (`providers`, `package`, `settings`,
//!   `snapshots`); `{env:<key variable>}` is substituted into it.
//! - OpenCode's own providers (`opencode-go`, `opencode`) take their key from a login stored in
//!   OpenCode's database first and from `OPENCODE_API_KEY` only without one, and a configured
//!   key does not change that. So the server is asked which key a built-in provider would use
//!   (`server2`), and VidAI's own provider [`VIDAI_PROVIDER`] runs the model whenever it
//!   would not be VidAI's key.
//! - `openaiApi` never uses OpenCode's own providers: [`VIDAI_PROVIDER`] runs it with the package
//!   `@ai-sdk/openai-compatible` at the address as given and the key in `VIDAI_API_KEY`.
//! - OpenCode 2 does not read `CLAUDE.md`; the Editing Folder's `CLAUDE.md` and the user's
//!   `~/.claude/CLAUDE.md` are named as instructions, like Claude Code reads them.
//! - The server runs with `--stdio`: it picks a free port itself, prints its address as one JSON
//!   line, ends when its stdin closes (also when VidAI itself ends) and keeps its password out of
//!   the environment of the commands it runs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::model::ApiOption;
use crate::opencode::{DEFAULT_BASE_URL, OPENAI_DEFAULT_BASE_URL, PAY_AS_YOU_GO_BASE_URL};

/// The only address a job's server listens on.
pub const HOST: &str = "127.0.0.1";
/// The variable that carries the key of `opencodeGo` (OpenCode's own name for its providers' key).
pub const KEY_VAR: &str = "OPENCODE_API_KEY";
/// The variable that carries the key of `openaiApi` (read only through VidAI's own provider).
pub const OPENAI_KEY_VAR: &str = "VIDAI_API_KEY";
/// The variable that carries the per-run configuration.
pub const CONFIG_VAR: &str = "OPENCODE_CONFIG_CONTENT";
/// The variable that carries the per-run server password (HTTP basic auth, user `opencode`).
pub const PASSWORD_VAR: &str = "OPENCODE_SERVER_PASSWORD";
/// The user name OpenCode expects with the password (its default).
pub const USERNAME: &str = "opencode";
/// OpenCode's provider for a Go subscription.
pub const GO_PROVIDER: &str = "opencode-go";
/// OpenCode's provider for the pay-as-you-go balance (OpenCode Zen).
pub const ZEN_PROVIDER: &str = "opencode";
/// The provider VidAI defines in the per-run configuration for its address: for `opencodeGo`
/// Anthropic's API at the address, the same way Claude Code reaches it (used for any other
/// address, and for a model OpenCode's own catalog does not list yet); for `openaiApi` an
/// OpenAI compatible API at the address, always.
pub const VIDAI_PROVIDER: &str = "vidai";

/// Variables of the user's environment that would change how VidAI talks to the server or which
/// key and configuration a run uses, removed before VidAI sets its own: both password variables
/// (`OPENCODE_PASSWORD` wins over `OPENCODE_SERVER_PASSWORD`), another configuration or key, and
/// feature flags that change how a turn runs.
pub const REMOVED_VARS: &[&str] = &[
    // A Claude gateway of the user's shell is not the address VidAI configures for the job.
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENCODE_PASSWORD",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_SERVER_USERNAME",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_API_KEY",
    "VIDAI_API_KEY",
    "OPENCODE_FLAGS",
];

/// Switches that keep a job's server to itself: no self-update.
pub const FIXED_VARS: &[(&str, &str)] = &[("OPENCODE_DISABLE_AUTOUPDATE", "1")];

/// Keeps the user's own OpenCode configuration out of a job's server (their MCP servers,
/// plugins, agents and commands). OpenCode 2 takes its global
/// config folder from `OPENCODE_CONFIG_DIR` when that is set, so an empty private folder of
/// VidAI's replaces the user's, and the Editing Folder's own project configuration is not read.
/// Best effort: when the folder cannot be made the job runs as before.
pub fn isolate_user_config(env: &mut HashMap<String, String>, private: &Path) {
    env.insert("OPENCODE_CONFIG_PROJECT_DISABLE".into(), "1".into());
    let dir = private.join("opencode2-config");
    if std::fs::create_dir_all(&dir).is_ok() {
        env.insert(
            "OPENCODE_CONFIG_DIR".into(),
            dir.to_string_lossy().into_owned(),
        );
    }
}

/// A model as OpenCode 2 names it in a session (`{"providerID","id"}`, plus the `variant` that
/// carries the reasoning effort when there is one).
pub fn model_json(model: &ModelRef, variant: Option<&str>) -> Value {
    let mut json = json!({ "providerID": model.provider_id, "id": model.model_id });
    if let Some(variant) = variant {
        json["variant"] = json!(variant);
    }
    json
}

/// The variable that carries the key of `option`.
pub fn key_var(option: ApiOption) -> &'static str {
    match option {
        ApiOption::OpenaiApi => OPENAI_KEY_VAR,
        ApiOption::OpencodeGo | ApiOption::AnthropicApi => KEY_VAR,
    }
}

/// The AI SDK package VidAI's own provider uses for `option`.
pub fn package(option: ApiOption) -> &'static str {
    match option {
        ApiOption::OpenaiApi => "@ai-sdk/openai-compatible",
        ApiOption::OpencodeGo | ApiOption::AnthropicApi => "@ai-sdk/anthropic",
    }
}

/// How a VidAI model choice (an address and a model id the user chose or typed) is run by
/// OpenCode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// One of OpenCode's own providers, which knows each model's protocol and price.
    Builtin { provider: &'static str },
    /// [`VIDAI_PROVIDER`]: Anthropic's API at the address (`opencodeGo` at any other address) or
    /// an OpenAI compatible API at the address (`openaiApi`).
    Custom,
}

/// The route of a normalized address of `option` (`opencode::normalize_base_url`; `None` is the
/// default address of `opencodeGo`). `openaiApi` is always [`Route::Custom`]: whatever its
/// address, none of OpenCode's own providers runs it.
pub fn route(option: ApiOption, base_url: Option<&str>) -> Route {
    if option == ApiOption::OpenaiApi {
        return Route::Custom;
    }
    match base_url.unwrap_or(DEFAULT_BASE_URL) {
        DEFAULT_BASE_URL => Route::Builtin {
            provider: GO_PROVIDER,
        },
        PAY_AS_YOU_GO_BASE_URL => Route::Builtin {
            provider: ZEN_PROVIDER,
        },
        _ => Route::Custom,
    }
}

/// A model as OpenCode names it: `<provider>/<model>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRef {
    pub provider_id: String,
    pub model_id: String,
}

impl ModelRef {
    pub fn new(provider_id: &str, model_id: &str) -> Self {
        Self {
            provider_id: provider_id.to_owned(),
            model_id: model_id.to_owned(),
        }
    }

    /// The model through VidAI's own provider (see [`VIDAI_PROVIDER`]).
    pub fn custom(model_id: &str) -> Self {
        Self::new(VIDAI_PROVIDER, model_id)
    }
}

impl std::fmt::Display for ModelRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.provider_id, self.model_id)
    }
}

/// The model variant that carries a reasoning `effort`: the effort itself when the model offers a
/// variant of that name (`offered`, from the server's catalog; `None` when it could not be read),
/// otherwise the sentence for the log that says the model runs on its default. OpenCode names
/// the variants of a model after the efforts it accepts, and refuses or ignores any other name,
/// so an effort the model lacks is never passed on.
pub fn variant_for_effort(
    model: &ModelRef,
    effort: &str,
    offered: Option<&[String]>,
) -> Result<String, String> {
    let model_id = &model.model_id;
    match offered {
        Some(list) if list.iter().any(|v| v == effort) => Ok(effort.to_owned()),
        Some([]) => Err(format!(
            "{model_id} has no reasoning effort levels, so the effort {effort} is not used."
        )),
        Some(list) => Err(format!(
            "{model_id} does not offer the reasoning effort {effort} (it offers {}), so it runs on its default.",
            list.join(", ")
        )),
        None => Err(format!(
            "The reasoning levels of {model_id} could not be read, so the effort {effort} is not used."
        )),
    }
}

impl Route {
    /// The model to ask for first; [`ModelRef::custom`] is the fallback when the built-in
    /// provider does not list the model.
    pub fn model(&self, model_id: &str) -> ModelRef {
        match self {
            Route::Builtin { provider } => ModelRef::new(provider, model_id),
            Route::Custom => ModelRef::custom(model_id),
        }
    }
}

/// The test switch of the real smoke scenario (`npm run e2e -- --real`, debug builds only): with
/// `VIDAI_E2E_OPENCODE_LOGIN` set, a job's server on `opencodeGo` gets no key from VidAI, whose
/// key store is the in-memory test store, and runs on the OpenCode program's own login (`own`) or,
/// ignoring that login without reading it, on OpenCode's public free tier (`public`). A release
/// build never reads the variable, and `openaiApi` ignores it, so a normal run always passes
/// VidAI's own key.
pub const TEST_LOGIN_VAR: &str = "VIDAI_E2E_OPENCODE_LOGIN";

/// Whether a test login is asked for `option`, in a debug build only.
pub fn test_login(option: ApiOption) -> bool {
    cfg!(debug_assertions)
        && option == ApiOption::OpencodeGo
        && matches!(
            std::env::var(TEST_LOGIN_VAR).as_deref(),
            Ok("own" | "public")
        )
}

/// A fresh password for one server (128 random bits).
pub fn new_password() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The per-run configuration (`OPENCODE_CONFIG_CONTENT`): no sharing, no snapshots of the Editing
/// Folder (it holds gigabytes of footage), no language servers or formatters, the instructions of
/// `CLAUDE.md`, and VidAI's own provider for the address and model: for `opencodeGo` Anthropic's
/// API at `<address>/v1` with the key, the way Claude Code reaches it; for `openaiApi` the package
/// `@ai-sdk/openai-compatible` with `baseURL` the address as given (it already ends in `/v1`).
/// The key is always `{env:<key variable>}` ([`key_var`]), never its value. Built-in providers
/// need nothing here: `OPENCODE_API_KEY` is their key. Permissions are not here: they belong to
/// the session ([`session_permissions`]), which OpenCode 2 applies after every configured rule.
pub fn run_config(
    option: ApiOption,
    base_url: Option<&str>,
    model_id: &str,
    editing_folder: &Path,
    home: Option<&Path>,
) -> Value {
    let (name, base_url) = match option {
        ApiOption::OpenaiApi => (
            "OpenAI Compatible API (VidAI)",
            base_url.unwrap_or(OPENAI_DEFAULT_BASE_URL).to_owned(),
        ),
        ApiOption::OpencodeGo | ApiOption::AnthropicApi => (
            "OpenCode (VidAI)",
            format!("{}/v1", base_url.unwrap_or(DEFAULT_BASE_URL)),
        ),
    };
    let mut instructions = vec![editing_folder.join("CLAUDE.md")];
    if let Some(home) = home {
        instructions.push(home.join(".claude").join("CLAUDE.md"));
    }
    json!({
        "$schema": "https://opencode.ai/config.json",
        "share": "disabled",
        "snapshots": false,
        "lsp": false,
        "formatter": false,
        "instructions": instructions
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        "providers": {
            VIDAI_PROVIDER: {
                "name": name,
                "package": package(option),
                "settings": {
                    "baseURL": base_url,
                    "apiKey": format!("{{env:{}}}", key_var(option)),
                },
                "models": { model_id: { "name": model_id } },
            },
        },
    })
}

/// The permission rules of a job's session: everything is allowed (the owner runs Claude Code
/// with every permission bypassed and wants the same), and the question tool, which would wait
/// for a person, is denied, which removes it. The last matching rule decides, and a session's
/// rules come after the agent's and every configured rule. (OpenCode 2 has no plan mode tools.)
pub fn session_permissions() -> Value {
    json!([
        { "action": "*", "resource": "*", "effect": "allow" },
        { "action": "question", "resource": "*", "effect": "deny" },
    ])
}

/// The complete environment of a job's server: `base` (the login-shell environment of the job)
/// without [`REMOVED_VARS`], plus the key (in the variable of `option`; none without one), the
/// password, the configuration and [`FIXED_VARS`].
pub fn server_env(
    option: ApiOption,
    base: &HashMap<String, String>,
    key: Option<&str>,
    password: &str,
    config: &Value,
) -> HashMap<String, String> {
    let mut env = base.clone();
    for var in REMOVED_VARS {
        env.remove(*var);
    }
    for (var, value) in FIXED_VARS {
        env.insert((*var).to_owned(), (*value).to_owned());
    }
    if let Some(key) = key {
        env.insert(key_var(option).into(), key.to_owned());
    }
    env.insert(PASSWORD_VAR.into(), password.to_owned());
    env.insert(CONFIG_VAR.into(), config.to_string());
    env
}

/// The run configuration without VidAI's key: the test login of [`TEST_LOGIN_VAR`], and an option
/// whose key is optional and not saved (`openaiApi` on a server that needs none, which then gets
/// no `Authorization` header). (OpenCode 2.2.6 refuses `apiKey: false`, "Expected JSON value", so
/// the key is left out.)
pub fn without_key(config: &mut Value) {
    if let Some(Value::Object(providers)) = config.get_mut("providers") {
        for provider in providers.values_mut() {
            if let Some(Value::Object(settings)) = provider.get_mut("settings") {
                settings.remove("apiKey");
            }
        }
    }
}

/// The environment of [`server_env`] for a test login: no key, also not the user's own Anthropic
/// key, which VidAI's provider would send without a key of its own. OpenCode 2 then runs on the
/// program's own login, or without one on OpenCode's public free tier (it has no way to ignore a
/// stored login, so `public` and `own` start the same server).
pub fn apply_test_login(env: &mut HashMap<String, String>) {
    env.remove(KEY_VAR);
    env.remove("ANTHROPIC_API_KEY");
}

/// One server process: the program, the Editing Folder as working directory and the environment
/// of [`server_env`].
#[derive(Debug, Clone)]
pub struct ServerCommand {
    pub program: PathBuf,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
}

impl ServerCommand {
    /// `serve --stdio --hostname 127.0.0.1 --port 0`: the server picks a free port on this
    /// computer and prints `{"url":"http://127.0.0.1:<port>"}` (OpenCode's own default would be
    /// 4096 and up, where the user's own server may listen), and it ends when its stdin closes.
    pub fn args(&self) -> Vec<String> {
        vec![
            "serve".into(),
            "--stdio".into(),
            "--hostname".into(),
            HOST.into(),
            "--port".into(),
            "0".into(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_map_to_providers_as_for_opencode_1() {
        assert_eq!(
            route(ApiOption::OpencodeGo, None)
                .model("glm-5.3")
                .to_string(),
            "opencode-go/glm-5.3"
        );
        assert_eq!(
            route(
                ApiOption::OpencodeGo,
                Some("https://opencode.ai/inference/anthropic")
            )
            .model("big-pickle")
            .to_string(),
            "opencode/big-pickle"
        );
        assert_eq!(
            route(
                ApiOption::OpencodeGo,
                Some("https://gateway.example/anthropic")
            )
            .model("m1")
            .to_string(),
            "vidai/m1"
        );
        // The OpenAI compatible option never uses OpenCode's own providers, whatever its address.
        for address in [
            None,
            Some(DEFAULT_BASE_URL),
            Some(PAY_AS_YOU_GO_BASE_URL),
            Some(OPENAI_DEFAULT_BASE_URL),
            Some("https://api.openai.com/v1"),
        ] {
            assert_eq!(
                route(ApiOption::OpenaiApi, address)
                    .model("gpt-5")
                    .to_string(),
                "vidai/gpt-5"
            );
        }
        assert_eq!(
            model_json(&ModelRef::new("opencode-go", "glm-5.3"), None).to_string(),
            r#"{"id":"glm-5.3","providerID":"opencode-go"}"#
        );
    }

    #[test]
    fn the_run_configuration_as_text() {
        assert_eq!(
            run_config(
                ApiOption::OpencodeGo,
                None,
                "glm-5.3",
                Path::new("/Users/editor/Editing"),
                Some(Path::new("/Users/editor"))
            )
            .to_string(),
            concat!(
                r#"{"$schema":"https://opencode.ai/config.json","formatter":false,"#,
                r#""instructions":["/Users/editor/Editing/CLAUDE.md","/Users/editor/.claude/CLAUDE.md"],"#,
                r#""lsp":false,"providers":{"vidai":{"models":{"glm-5.3":{"name":"glm-5.3"}},"#,
                r#""name":"OpenCode (VidAI)","package":"@ai-sdk/anthropic","#,
                r#""settings":{"apiKey":"{env:OPENCODE_API_KEY}","baseURL":"https://opencode.ai/inference/go/anthropic/v1"}}},"#,
                r#""share":"disabled","snapshots":false}"#
            )
        );
        let custom = run_config(
            ApiOption::OpencodeGo,
            Some("http://localhost:8080"),
            "m1",
            Path::new("/E"),
            None,
        );
        assert_eq!(custom["instructions"], json!(["/E/CLAUDE.md"]));
        assert_eq!(
            custom["providers"]["vidai"]["settings"],
            json!({ "baseURL": "http://localhost:8080/v1", "apiKey": "{env:OPENCODE_API_KEY}" })
        );
        let pay = run_config(
            ApiOption::OpencodeGo,
            Some("https://opencode.ai/inference/anthropic"),
            "m1",
            Path::new("/E"),
            None,
        );
        assert_eq!(
            pay["providers"]["vidai"]["settings"]["baseURL"],
            "https://opencode.ai/inference/anthropic/v1"
        );
        let mut test = pay.clone();
        without_key(&mut test);
        assert_eq!(
            test["providers"]["vidai"]["settings"],
            json!({ "baseURL": "https://opencode.ai/inference/anthropic/v1" })
        );
    }

    #[test]
    fn the_openai_run_configuration_as_text() {
        assert_eq!(
            run_config(
                ApiOption::OpenaiApi,
                Some("https://api.openai.com/v1"),
                "gpt-5",
                Path::new("/Users/editor/Editing"),
                Some(Path::new("/Users/editor"))
            )
            .to_string(),
            concat!(
                r#"{"$schema":"https://opencode.ai/config.json","formatter":false,"#,
                r#""instructions":["/Users/editor/Editing/CLAUDE.md","/Users/editor/.claude/CLAUDE.md"],"#,
                r#""lsp":false,"providers":{"vidai":{"models":{"gpt-5":{"name":"gpt-5"}},"#,
                r#""name":"OpenAI Compatible API (VidAI)","package":"@ai-sdk/openai-compatible","#,
                r#""settings":{"apiKey":"{env:VIDAI_API_KEY}","baseURL":"https://api.openai.com/v1"}}},"#,
                r#""share":"disabled","snapshots":false}"#
            )
        );
        // The default address is used as given, with its /v1, and no key value is in the text.
        let default = run_config(ApiOption::OpenaiApi, None, "m1", Path::new("/E"), None);
        assert_eq!(
            default["providers"]["vidai"]["settings"],
            json!({ "baseURL": "https://opencode.ai/inference/go/v1", "apiKey": "{env:VIDAI_API_KEY}" })
        );
        let local = run_config(
            ApiOption::OpenaiApi,
            Some("http://localhost:11434/v1"),
            "llama",
            Path::new("/E"),
            None,
        );
        assert_eq!(
            local["providers"]["vidai"]["settings"]["baseURL"],
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn each_option_has_its_own_key_variable() {
        assert_eq!(key_var(ApiOption::OpencodeGo), "OPENCODE_API_KEY");
        assert_eq!(key_var(ApiOption::OpenaiApi), "VIDAI_API_KEY");
        assert!(!test_login(ApiOption::OpenaiApi));
    }

    #[test]
    fn the_session_allows_everything_and_asks_nothing() {
        assert_eq!(
            session_permissions().to_string(),
            concat!(
                r#"[{"action":"*","effect":"allow","resource":"*"},"#,
                r#"{"action":"question","effect":"deny","resource":"*"}]"#
            )
        );
    }

    #[test]
    fn the_server_environment() {
        let base = HashMap::from([
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("HOME".to_owned(), "/Users/editor".to_owned()),
            ("OPENCODE_PASSWORD".to_owned(), "theirs".to_owned()),
            ("OPENCODE_SERVER_PASSWORD".to_owned(), "theirs".to_owned()),
            ("OPENCODE_API_KEY".to_owned(), "their-own-key".to_owned()),
            ("OPENCODE_FLAGS".to_owned(), "all".to_owned()),
            ("MY_TOOL_TOKEN".to_owned(), "tok".to_owned()),
        ]);
        let config = json!({ "share": "disabled" });
        let mut env = server_env(
            ApiOption::OpencodeGo,
            &base,
            Some("oc_sk_job"),
            "pw",
            &config,
        );
        let lines = |env: &HashMap<String, String>| {
            let mut lines: Vec<String> = env.iter().map(|(k, v)| format!("{k}={v}")).collect();
            lines.sort();
            lines.join("\n")
        };
        assert_eq!(
            lines(&env),
            [
                "HOME=/Users/editor",
                "MY_TOOL_TOKEN=tok",
                "OPENCODE_API_KEY=oc_sk_job",
                r#"OPENCODE_CONFIG_CONTENT={"share":"disabled"}"#,
                "OPENCODE_DISABLE_AUTOUPDATE=1",
                "OPENCODE_SERVER_PASSWORD=pw",
                "PATH=/usr/bin:/bin",
            ]
            .join("\n")
        );
        apply_test_login(&mut env);
        assert!(!env.contains_key("OPENCODE_API_KEY"));
    }

    #[test]
    fn the_openai_server_environment_carries_the_key_in_vidais_variable() {
        let base = HashMap::from([
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("OPENCODE_API_KEY".to_owned(), "their-own-key".to_owned()),
            ("VIDAI_API_KEY".to_owned(), "their-other-key".to_owned()),
        ]);
        let env = server_env(
            ApiOption::OpenaiApi,
            &base,
            Some("sk-job"),
            "pw",
            &json!({ "share": "disabled" }),
        );
        let mut lines: Vec<String> = env.iter().map(|(k, v)| format!("{k}={v}")).collect();
        lines.sort();
        assert_eq!(
            lines,
            [
                r#"OPENCODE_CONFIG_CONTENT={"share":"disabled"}"#,
                "OPENCODE_DISABLE_AUTOUPDATE=1",
                "OPENCODE_SERVER_PASSWORD=pw",
                "PATH=/usr/bin",
                "VIDAI_API_KEY=sk-job",
            ]
        );
    }

    #[test]
    fn a_server_without_a_key_has_none_of_the_users_own_and_no_apikey_setting() {
        let base = HashMap::from([
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("OPENCODE_API_KEY".to_owned(), "their-own-key".to_owned()),
            ("VIDAI_API_KEY".to_owned(), "their-other-key".to_owned()),
        ]);
        let mut config = run_config(
            ApiOption::OpenaiApi,
            Some("http://localhost:1234/v1"),
            "local-model",
            Path::new("/Users/editor/Editing"),
            None,
        );
        without_key(&mut config);
        assert!(
            config["providers"][VIDAI_PROVIDER]["settings"]
                .get("apiKey")
                .is_none()
        );
        let env = server_env(ApiOption::OpenaiApi, &base, None, "pw", &config);
        assert!(!env.contains_key("VIDAI_API_KEY"));
        assert!(!env.contains_key("OPENCODE_API_KEY"));
    }

    #[test]
    fn the_command_line() {
        let command = ServerCommand {
            program: "/Users/editor/.opencode/bin/opencode2".into(),
            cwd: "/Users/editor/Editing".into(),
            env: HashMap::new(),
        };
        assert_eq!(
            command.args().join(" "),
            "serve --stdio --hostname 127.0.0.1 --port 0"
        );
    }
}

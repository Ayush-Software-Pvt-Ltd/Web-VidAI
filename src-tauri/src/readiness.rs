//! What new edits need on this computer: the ONE decision (SPEC section 6, "Readiness of a
//! launch", with its table), used by `commands::jobs::ensure_ready` before every command that
//! would start an edit. The UI has the same function in `src/lib/readiness.ts` (`problemOf`);
//! `src-tauri/tests/fixtures/readiness-table.json` is run by both sides, so they cannot disagree.
//!
//! The inputs are plain facts ([`Facts`]), so every combination is a unit test. [`Facts::problem`]
//! is pure; [`check`] gathers the facts of the running app, looking only at what the setup needs
//! (an edit on option 2 or 4 never runs `claude`, an edit on option 1 or 3 never runs
//! `opencode2 --version`, and only option 1 runs `claude auth status`), and turns the problem
//! into the `AppError` the commands reject with.
//!
//! The rule in one sentence: only the program that does the editing is needed, with the service
//! it runs on.
//!
//! - The program follows from the setup ([`Setup::harness`]): Claude Code for `claudeSubscription`
//!   and `anthropicApi`, the OpenCode 2 program for `opencodeGo` and `openaiApi`.
//! - An API option needs its saved key and its chosen model, whatever the program is.
//! - Claude Code needs to be installed (and Git for Windows on Windows), and logged in only on
//!   `claudeSubscription`.
//! - The OpenCode 2 program needs to be installed in a version VidAI drives.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::model::{Harness, OpencodeCli, Setup};

/// What is known of Claude Code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudeState {
    /// Not installed.
    None,
    /// Installed, not logged in.
    LoggedOut,
    /// Installed and logged in.
    Ready,
}

/// What is known of the OpenCode 2 program.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliState {
    /// Not installed.
    None,
    /// Installed, in a version VidAI does not drive.
    Unsupported,
    /// Installed, in a version VidAI drives.
    Ready,
}

impl CliState {
    pub fn of(cli: &OpencodeCli) -> Self {
        match (cli.found, cli.supported) {
            (false, _) => Self::None,
            (true, false) => Self::Unsupported,
            (true, true) => Self::Ready,
        }
    }
}

/// Everything the decision depends on (SPEC section 6, "Readiness of a launch").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    /// How edits run.
    pub setup: Setup,
    /// The setup's API key is saved (counts only on OpenCode Go: the other two API options work
    /// without a key).
    pub key_saved: bool,
    /// The setup's model is chosen (counts only for the three API options).
    pub model_chosen: bool,
    /// Windows: Git for Windows is missing (`false` on a Mac).
    pub git_bash_missing: bool,
    pub claude: ClaudeState,
    /// The OpenCode 2 program.
    pub program: CliState,
    /// The computer is prepared for edits (tools, Python environment, Whisper model: the
    /// "prepare this computer" step). Always `true` until that exists; here so the decision can
    /// take it as one more row.
    pub prepared: bool,
}

/// What blocks new edits, in the order the person is asked to fix it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    /// The setup is OpenCode Go and its key is not saved (the other API options need no key).
    ApiKeyMissing,
    /// The setup is an API option and its model is not chosen.
    ApiModelMissing,
    GitBashMissing,
    ClaudeMissing,
    /// Only on `claudeSubscription`.
    ClaudeLoggedOut,
    /// The OpenCode 2 program is not installed.
    ProgramMissing,
    /// The OpenCode 2 program is installed in a version VidAI does not drive.
    ProgramUnsupported,
    NotPrepared,
}

impl Problem {
    /// Every problem, in the order of the SPEC table.
    pub const ALL: [Problem; 8] = [
        Self::ApiKeyMissing,
        Self::ApiModelMissing,
        Self::GitBashMissing,
        Self::ClaudeMissing,
        Self::ClaudeLoggedOut,
        Self::ProgramMissing,
        Self::ProgramUnsupported,
        Self::NotPrepared,
    ];

    /// The name the table fixture and the UI use.
    pub fn code(self) -> &'static str {
        match self {
            Self::ApiKeyMissing => "apiKeyMissing",
            Self::ApiModelMissing => "apiModelMissing",
            Self::GitBashMissing => "gitBashMissing",
            Self::ClaudeMissing => "claudeMissing",
            Self::ClaudeLoggedOut => "claudeLoggedOut",
            Self::ProgramMissing => "programMissing",
            Self::ProgramUnsupported => "programUnsupported",
            Self::NotPrepared => "notPrepared",
        }
    }
}

impl Facts {
    /// `setup` with everything it needs in place (the caller sets what it looked at).
    pub fn ready(setup: Setup) -> Self {
        Self {
            setup,
            key_saved: true,
            model_chosen: true,
            git_bash_missing: false,
            claude: ClaudeState::Ready,
            program: CliState::Ready,
            prepared: true,
        }
    }

    /// THE program that does the editing: it follows from the setup.
    pub fn harness(&self) -> Harness {
        self.setup.harness()
    }

    /// The first thing that blocks new edits, or `None` when they can start.
    pub fn problem(&self) -> Option<Problem> {
        if let Some(option) = self.setup.api_option() {
            // Only OpenCode Go needs its key: `anthropicApi` and `openaiApi` are often a server on
            // this computer that needs none.
            if option.key_required() && !self.key_saved {
                return Some(Problem::ApiKeyMissing);
            }
            if !self.model_chosen {
                return Some(Problem::ApiModelMissing);
            }
        }
        match self.harness() {
            Harness::ClaudeCode => {
                if self.git_bash_missing {
                    return Some(Problem::GitBashMissing);
                }
                match self.claude {
                    ClaudeState::None => return Some(Problem::ClaudeMissing),
                    // Only the Claude subscription needs a login: an API option brings its own key.
                    ClaudeState::LoggedOut if self.setup == Setup::ClaudeSubscription => {
                        return Some(Problem::ClaudeLoggedOut);
                    }
                    ClaudeState::LoggedOut | ClaudeState::Ready => {}
                }
            }
            Harness::Opencode2 => match self.program {
                CliState::None => return Some(Problem::ProgramMissing),
                CliState::Unsupported => return Some(Problem::ProgramUnsupported),
                CliState::Ready => {}
            },
        }
        (!self.prepared).then_some(Problem::NotPrepared)
    }
}

/// Checks that new work can start now, looking only at what the setup needs. Errors are the
/// ones the commands reject with: `claudeNotInstalled`, `claudeNotLoggedIn`, `gitBashMissing`,
/// `secretsUnavailable`, and `invalidInput` with the reason for everything else.
/// Blocking (it may run `claude auth status` or `opencode2 --version`).
pub fn check(app: &AppHandle) -> AppResult<()> {
    let settings = app.state::<crate::store::Store>().settings();
    let setup = settings.setup;
    let mut facts = Facts::ready(setup);
    if let Some(option) = setup.api_option() {
        let api = crate::opencode::current_api_setup(app, option)?;
        facts.key_saved = api.key.is_some();
        facts.model_chosen = api.model.is_some();
    }
    // The key and the model come first: nothing is run for a setup that cannot start anyway.
    if let Some(problem @ (Problem::ApiKeyMissing | Problem::ApiModelMissing)) = facts.problem() {
        return Err(error_of(setup, problem, None));
    }
    let mut cli: Option<OpencodeCli> = None;
    match facts.harness() {
        Harness::ClaudeCode => {
            if crate::claude::locate::find().is_none() {
                facts.claude = ClaudeState::None;
            }
            match crate::claude::auth::check_prerequisites(&crate::claude::env::child_env()) {
                Ok(()) => {}
                Err(err) if err.code == crate::error::ErrorCode::GitBashMissing => {
                    facts.git_bash_missing = true;
                }
                Err(err) => return Err(err),
            }
            // The login only matters on the Claude subscription (`claude auth status`).
            if setup == Setup::ClaudeSubscription
                && facts.claude == ClaudeState::Ready
                && !facts.git_bash_missing
                && let Err(err) = crate::claude::auth::ensure_ready_blocking()
            {
                if err.code == crate::error::ErrorCode::ClaudeNotLoggedIn {
                    facts.claude = ClaudeState::LoggedOut;
                } else {
                    return Err(err);
                }
            }
        }
        Harness::Opencode2 => {
            let status = crate::opencode::harness::locate2::status();
            facts.program = CliState::of(&status);
            cli = Some(status);
        }
    }
    match facts.problem() {
        None => Ok(()),
        Some(problem) => Err(error_of(setup, problem, cli.as_ref())),
    }
}

/// The computer, as the messages say it.
fn computer() -> &'static str {
    if cfg!(windows) { "PC" } else { "Mac" }
}

/// The error a command rejects with for `problem` on `setup`. `cli` is what was found of the
/// OpenCode 2 program, when it was looked at.
pub fn error_of(setup: Setup, problem: Problem, cli: Option<&OpencodeCli>) -> AppError {
    let service = setup.service_name();
    let settings = "Settings, Harness + API Keys";
    match problem {
        Problem::ApiKeyMissing => AppError::invalid_input(format!(
            "No API key is saved for {service}. Edits are set to run on it ({settings})."
        )),
        Problem::ApiModelMissing => AppError::invalid_input(format!(
            "No model is chosen for {service}. Edits are set to run on it ({settings})."
        )),
        Problem::GitBashMissing => AppError::git_bash_missing(),
        Problem::ClaudeMissing => AppError::claude_not_installed(),
        Problem::ClaudeLoggedOut => AppError::claude_not_logged_in(),
        Problem::ProgramMissing | Problem::ProgramUnsupported => {
            let default = OpencodeCli::default();
            let cli = cli.unwrap_or(&default);
            let reason = crate::opencode::harness::locate2::problem(cli)
                .unwrap_or_else(|| format!("OpenCode 2 cannot be used on this {}.", computer()));
            AppError::invalid_input(format!(
                "{reason} Edits are set to run with OpenCode 2 ({settings})."
            ))
        }
        Problem::NotPrepared => AppError::invalid_input(format!(
            "This {} is not prepared for edits yet.",
            computer()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every value of every fact, in a fixed order: the whole domain of the decision.
    fn every_fact() -> Vec<Facts> {
        let mut all = Vec::new();
        for setup in Setup::ALL {
            for key_saved in [false, true] {
                for model_chosen in [false, true] {
                    for git_bash_missing in [false, true] {
                        for claude in [
                            ClaudeState::None,
                            ClaudeState::LoggedOut,
                            ClaudeState::Ready,
                        ] {
                            for program in [CliState::None, CliState::Unsupported, CliState::Ready]
                            {
                                for prepared in [false, true] {
                                    all.push(Facts {
                                        setup,
                                        key_saved,
                                        model_chosen,
                                        git_bash_missing,
                                        claude,
                                        program,
                                        prepared,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        all
    }

    fn of_setup(setup: Setup) -> impl Iterator<Item = Facts> {
        every_fact().into_iter().filter(move |f| f.setup == setup)
    }

    #[test]
    fn the_domain_is_every_combination() {
        assert_eq!(every_fact().len(), 4 * 2 * 2 * 2 * 3 * 3 * 2);
    }

    #[test]
    fn the_program_follows_the_setup() {
        assert_eq!(
            Facts::ready(Setup::ClaudeSubscription).harness(),
            Harness::ClaudeCode
        );
        assert_eq!(
            Facts::ready(Setup::AnthropicApi).harness(),
            Harness::ClaudeCode
        );
        assert_eq!(
            Facts::ready(Setup::OpencodeGo).harness(),
            Harness::Opencode2
        );
        assert_eq!(Facts::ready(Setup::OpenaiApi).harness(), Harness::Opencode2);
    }

    #[test]
    fn option_1_never_asks_for_a_key_a_model_or_the_opencode_program() {
        for f in of_setup(Setup::ClaudeSubscription) {
            assert!(
                !matches!(
                    f.problem(),
                    Some(
                        Problem::ApiKeyMissing
                            | Problem::ApiModelMissing
                            | Problem::ProgramMissing
                            | Problem::ProgramUnsupported
                    )
                ),
                "{f:?}"
            );
        }
    }

    #[test]
    fn options_2_and_4_never_ask_for_claude_code_a_login_or_git() {
        for setup in [Setup::OpencodeGo, Setup::OpenaiApi] {
            for f in of_setup(setup) {
                assert!(
                    !matches!(
                        f.problem(),
                        Some(
                            Problem::GitBashMissing
                                | Problem::ClaudeMissing
                                | Problem::ClaudeLoggedOut
                        )
                    ),
                    "{f:?}"
                );
            }
        }
    }

    #[test]
    fn option_3_needs_claude_code_and_git_but_never_a_login_or_the_opencode_program() {
        for f in of_setup(Setup::AnthropicApi) {
            let problem = f.problem();
            assert!(
                !matches!(
                    problem,
                    Some(
                        Problem::ClaudeLoggedOut
                            | Problem::ProgramMissing
                            | Problem::ProgramUnsupported
                    )
                ),
                "{f:?}"
            );
            // A key is never asked for on option 3.
            assert_ne!(problem, Some(Problem::ApiKeyMissing), "{f:?}");
            if f.model_chosen && f.git_bash_missing {
                assert_eq!(problem, Some(Problem::GitBashMissing), "{f:?}");
            }
            if f.model_chosen && !f.git_bash_missing && f.claude == ClaudeState::None {
                assert_eq!(problem, Some(Problem::ClaudeMissing), "{f:?}");
            }
        }
    }

    #[test]
    fn the_login_is_asked_on_option_1_only() {
        for f in every_fact() {
            if f.problem() == Some(Problem::ClaudeLoggedOut) {
                assert_eq!(f.setup, Setup::ClaudeSubscription, "{f:?}");
                assert_eq!(f.claude, ClaudeState::LoggedOut, "{f:?}");
            }
        }
    }

    #[test]
    fn the_model_is_asked_first_on_an_api_option_and_the_key_on_opencode_go_only() {
        for f in every_fact() {
            let api = f.setup.api_option();
            let expected = if api.is_none() {
                None
            } else if api.is_some_and(|o| o.key_required()) && !f.key_saved {
                Some(Problem::ApiKeyMissing)
            } else if !f.model_chosen {
                Some(Problem::ApiModelMissing)
            } else {
                None
            };
            let got = f
                .problem()
                .filter(|p| matches!(p, Problem::ApiKeyMissing | Problem::ApiModelMissing));
            assert_eq!(got, expected, "{f:?}");
            if expected.is_some() {
                assert_eq!(f.problem(), expected, "{f:?}");
            }
        }
    }

    #[test]
    fn facts_the_setup_does_not_look_at_never_change_the_answer() {
        for f in every_fact() {
            let base = f.problem();
            let mut others = Vec::new();
            match f.harness() {
                Harness::ClaudeCode => {
                    for program in [CliState::None, CliState::Unsupported, CliState::Ready] {
                        others.push(Facts { program, ..f });
                    }
                }
                Harness::Opencode2 => {
                    for claude in [
                        ClaudeState::None,
                        ClaudeState::LoggedOut,
                        ClaudeState::Ready,
                    ] {
                        for git_bash_missing in [false, true] {
                            others.push(Facts {
                                claude,
                                git_bash_missing,
                                ..f
                            });
                        }
                    }
                }
            }
            if f.setup == Setup::ClaudeSubscription {
                for key_saved in [false, true] {
                    for model_chosen in [false, true] {
                        others.push(Facts {
                            key_saved,
                            model_chosen,
                            ..f
                        });
                    }
                }
            }
            if matches!(f.setup, Setup::AnthropicApi | Setup::OpenaiApi) {
                // Options 3 and 4 work without a key: saved or not is the same to them.
                others.push(Facts {
                    key_saved: !f.key_saved,
                    ..f
                });
            }
            if f.setup == Setup::AnthropicApi && f.claude != ClaudeState::None {
                // Installed is what it needs: logged out or ready is the same to it.
                for claude in [ClaudeState::LoggedOut, ClaudeState::Ready] {
                    others.push(Facts { claude, ..f });
                }
            }
            for other in others {
                assert_eq!(other.problem(), base, "{f:?} against {other:?}");
            }
        }
    }

    #[test]
    fn a_computer_that_is_not_prepared_is_the_last_thing_asked() {
        for f in every_fact() {
            let mut ready = f;
            ready.prepared = true;
            match ready.problem() {
                Some(problem) => assert_eq!(f.problem(), Some(problem), "{f:?}"),
                None => assert_eq!(
                    f.problem(),
                    (!f.prepared).then_some(Problem::NotPrepared),
                    "{f:?}"
                ),
            }
        }
    }

    #[test]
    fn everything_in_place_is_ready_on_every_setup() {
        for setup in Setup::ALL {
            assert_eq!(Facts::ready(setup).problem(), None, "{setup:?}");
        }
    }

    #[test]
    fn every_problem_is_reachable() {
        let reached: std::collections::HashSet<_> =
            every_fact().iter().filter_map(Facts::problem).collect();
        for problem in Problem::ALL {
            assert!(reached.contains(&problem), "{problem:?}");
        }
    }

    #[test]
    fn the_table_of_the_spec_holds_on_both_sides() {
        #[derive(Deserialize)]
        struct Row {
            name: String,
            facts: Facts,
            program: Harness,
            problem: Option<String>,
        }
        let rows: Vec<Row> =
            serde_json::from_str(include_str!("../tests/fixtures/readiness-table.json"))
                .expect("the table parses");
        assert!(rows.len() >= 50, "{}", rows.len());
        let names: std::collections::HashSet<_> = rows.iter().map(|r| &r.name).collect();
        assert_eq!(names.len(), rows.len(), "row names are unique");
        let mut setups = std::collections::HashSet::new();
        let mut problems = std::collections::HashSet::new();
        for row in rows {
            assert_eq!(row.facts.harness(), row.program, "{}", row.name);
            let problem = row.facts.problem().map(Problem::code);
            assert_eq!(problem, row.problem.as_deref(), "{}", row.name);
            setups.insert(row.facts.setup);
            problems.extend(problem);
        }
        assert_eq!(setups.len(), Setup::ALL.len(), "every setup has rows");
        for problem in Problem::ALL {
            assert!(problems.contains(problem.code()), "no row for {problem:?}");
        }
    }

    #[test]
    fn every_problem_has_an_error_and_a_distinct_code() {
        let codes: std::collections::HashSet<_> = Problem::ALL.iter().map(|p| p.code()).collect();
        assert_eq!(codes.len(), Problem::ALL.len());
        for problem in Problem::ALL {
            for setup in Setup::ALL {
                assert!(!error_of(setup, problem, None).message.is_empty());
            }
        }
    }

    #[test]
    fn the_messages_name_the_option_the_place_to_fix_it_and_the_computer() {
        let key = error_of(Setup::OpencodeGo, Problem::ApiKeyMissing, None);
        assert_eq!(
            key.message,
            "No API key is saved for OpenCode Go. Edits are set to run on it (Settings, Harness + API Keys)."
        );
        let model = error_of(Setup::OpenaiApi, Problem::ApiModelMissing, None);
        assert!(
            model
                .message
                .starts_with("No model is chosen for OpenAI Compatible API.")
        );
        let computer = if cfg!(windows) { "PC" } else { "Mac" };
        let missing = error_of(Setup::OpencodeGo, Problem::ProgramMissing, None);
        assert_eq!(
            missing.message,
            format!(
                "OpenCode 2 is not installed on this {computer}. Edits are set to run with OpenCode 2 (Settings, Harness + API Keys)."
            )
        );
        let unsupported_cli = OpencodeCli {
            found: true,
            version: Some("1.4.0".into()),
            ..OpencodeCli::default()
        };
        let unsupported = error_of(
            Setup::OpencodeGo,
            Problem::ProgramUnsupported,
            Some(&unsupported_cli),
        );
        assert!(
            unsupported.message.contains("1.4.0"),
            "{}",
            unsupported.message
        );
        assert!(
            unsupported
                .message
                .ends_with("(Settings, Harness + API Keys).")
        );
        assert!(
            error_of(Setup::ClaudeSubscription, Problem::NotPrepared, None)
                .message
                .contains(computer)
        );
    }
}

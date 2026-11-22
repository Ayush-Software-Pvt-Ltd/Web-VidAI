//! What a job runs on: the provider and its model and effort (SPEC section 6, "Provider of a
//! job"). Pure decisions, unit tested here and used by the manager (a new job) and the driver (a
//! launch).
//!
//! - A new edit uses the current selection of Settings ([`current`]).
//! - Continue, Re-Edit and Render Final resume the video's session, so they stay on the provider
//!   and model that session was written with ([`for_follow_up`]): a conversation written by one
//!   model family cannot be safely replayed to another.
//! - At launch ([`choose`]): when the job's own provider cannot run it now (the OpenCode key was
//!   removed, the model is gone, Claude Code was logged out, OpenCode does not exist here), a job
//!   that resumes a session starts a new session on the current selection instead, with the full
//!   instructions and a status line in the log, like a session Claude Code no longer has. A job
//!   that starts a new session anyway fails with the reason.

use crate::model::{Harness, JobView, Settings, Setup};
use crate::opencode;

/// The setup, model and effort of a job, and the program its session runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runner {
    /// How the session runs (SPEC section 7a): the Claude subscription or an API option.
    pub setup: Setup,
    /// Claude Code, or the OpenCode 2 program (what the setup says, SPEC section 7a).
    pub harness: Harness,
    /// `--model`: a Claude model (`null` is Claude Code's default) or the model of the API option.
    pub model: Option<String>,
    /// `--effort` on the Claude subscription; on an API option the reasoning effort of the model
    /// (Claude Code `--effort`, or the model variant in the OpenCode 2 program).
    pub effort: Option<String>,
}

impl Runner {
    /// What `job` runs on.
    pub fn of(job: &JobView) -> Self {
        Self {
            setup: job.setup,
            harness: job.harness(),
            model: job.model.clone(),
            effort: job.effort.clone(),
        }
    }

    /// "OpenCode Go (glm-5.3)", "Anthropic Compatible API (x) in the OpenCode 2 program", "the
    /// Claude subscription".
    pub fn describe(&self) -> String {
        let service = match (self.setup, self.model.as_deref()) {
            (Setup::ClaudeSubscription, _) => "the Claude subscription".to_owned(),
            (setup, Some(model)) => format!("{} ({model})", setup.service_name()),
            (setup, None) => setup.service_name().to_owned(),
        };
        match self.harness {
            Harness::Opencode2 => format!("{service} in the OpenCode 2 program"),
            Harness::ClaudeCode => service,
        }
    }

    /// Whether this runner runs on an API option (its key, address and model are needed).
    pub fn is_api(&self) -> bool {
        self.setup.api_option().is_some()
    }
}

/// The selection of Settings: the selected API option with its model and the program of its setup,
/// or the Claude subscription with the model and effort of the top bar, in Claude Code.
pub fn current(settings: &Settings) -> Runner {
    match settings.setup.api_option() {
        Some(option) => {
            let api = settings.api_options.get(option);
            Runner {
                setup: settings.setup,
                harness: crate::harness::for_new_job(settings),
                model: api.model.clone(),
                effort: api.model.as_ref().and_then(|m| api.efforts.get(m)).cloned(),
            }
        }
        None => Runner {
            setup: Setup::ClaudeSubscription,
            harness: Harness::ClaudeCode,
            model: settings.model.clone(),
            effort: settings.effort.clone(),
        },
    }
}

/// A Re-Edit or Render Final that resumes `resume`, the session of `previous`: on an API option it
/// keeps the session's setup, model and program; on the Claude subscription it uses the model and
/// effort selected now. Without a session to resume, the current selection.
pub fn for_follow_up(
    previous: Option<&JobView>,
    resume: Option<&str>,
    settings: &Settings,
) -> Runner {
    let previous = previous.filter(|_| resume.is_some());
    match previous.and_then(|p| p.setup.api_option().map(|option| (p, option))) {
        Some((previous, option)) => Runner {
            setup: previous.setup,
            harness: previous.harness(),
            model: previous.model.clone(),
            effort: previous
                .model
                .as_ref()
                .and_then(|m| settings.api_options.get(option).efforts.get(m))
                .cloned(),
        },
        None if previous.is_some() => Runner {
            setup: Setup::ClaudeSubscription,
            harness: Harness::ClaudeCode,
            model: settings.model.clone(),
            effort: settings.effort.clone(),
        },
        None => current(settings),
    }
}

/// Why a runner cannot start Claude Code now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// Claude Code is not installed: nothing else can help.
    NotInstalled(String),
    /// Claude Code is logged out (Claude subscription only).
    LoggedOut(String),
    /// The API option cannot run it (`opencode::ApiSetup::problem_with`).
    Api(String),
    /// Anything else, with its message.
    Other(String),
}

impl Problem {
    pub fn message(&self) -> &str {
        match self {
            Self::NotInstalled(m) | Self::LoggedOut(m) | Self::Api(m) | Self::Other(m) => m,
        }
    }
}

/// What a launch does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    /// Run on the job's own runner.
    Keep,
    /// Start a new session on this runner, and say so with this log line.
    SwitchTo(Runner, String),
    /// Fail the job with this message.
    Fail(String),
}

/// The decision at launch. `own` is what is wrong with the job's runner (`None`: nothing),
/// `resuming` whether the launch would resume a session, and `current_problem` what is wrong
/// with the current selection (asked only when it matters).
pub fn choose(
    job: &Runner,
    own: Option<Problem>,
    resuming: bool,
    current: &Runner,
    current_problem: impl FnOnce() -> Option<Problem>,
) -> Choice {
    let Some(own) = own else {
        return Choice::Keep;
    };
    if let Problem::NotInstalled(message) = own {
        return Choice::Fail(message);
    }
    if resuming && current != job && current_problem().is_none() {
        let reason = own.message().trim_end_matches('.');
        return Choice::SwitchTo(
            current.clone(),
            format!(
                "This video's session ran on {}, which cannot continue it now ({reason}). A new session on {} gets the full instructions.",
                job.describe(),
                current.describe()
            ),
        );
    }
    Choice::Fail(match own {
        Problem::Api(message) => format!(
            "{} Fix it in Settings, Harness + API Keys, then press Continue Editing.",
            message.trim_end()
        ),
        Problem::NotInstalled(message) | Problem::LoggedOut(message) | Problem::Other(message) => {
            message
        }
    })
}

/// What is wrong with running `runner` on `setup` (API options only; the Claude subscription is
/// checked by starting Claude Code).
pub fn api_problem(runner: &Runner, setup: &opencode::ApiSetup) -> Option<Problem> {
    runner
        .is_api()
        .then(|| setup.problem_with(runner.model.as_deref()))
        .flatten()
        .map(Problem::Api)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{JobKind, JobState, ToolkitKind, VideoType};

    /// Settings on `setup` with a model for every API option and a Claude model in the top bar.
    fn settings(setup: Setup) -> Settings {
        let mut s = Settings {
            setup,
            model: Some("opus".into()),
            effort: Some("high".into()),
            ..Settings::default()
        };
        s.api_options.opencode_go.model = Some("glm-5.3".into());
        s.api_options.anthropic_api.model = Some("claude-x".into());
        s.api_options.openai_api.model = Some("gpt-x".into());
        s
    }

    fn job(setup: Setup, model: &str) -> JobView {
        JobView {
            id: "j".into(),
            video_id: "c/v".into(),
            kind: JobKind::Edit,
            state: JobState::Completed,
            session_id: Some("s1".into()),
            toolkit: ToolkitKind::Standard,
            model: Some(model.into()),
            effort: None,
            video_type: VideoType::Long,
            created_at: String::new(),
            started_at: None,
            ended_at: None,
            active_ms: 0,
            running_since: None,
            last_activity: None,
            error: None,
            cost_usd: None,
            progress: None,
            starts_at: None,
            setup,
            harness: Some(setup.harness()),
        }
    }

    fn claude(model: &str, effort: &str) -> Runner {
        Runner {
            setup: Setup::ClaudeSubscription,
            harness: Harness::ClaudeCode,
            model: Some(model.into()),
            effort: Some(effort.into()),
        }
    }

    /// The runner of `setup` with `model` and no effort.
    fn api(setup: Setup, model: &str) -> Runner {
        Runner {
            setup,
            harness: setup.harness(),
            model: Some(model.into()),
            effort: None,
        }
    }

    fn opencode(model: &str) -> Runner {
        api(Setup::OpencodeGo, model)
    }

    #[test]
    fn a_new_edit_uses_the_current_selection() {
        assert_eq!(current(&settings(Setup::OpencodeGo)), opencode("glm-5.3"));
        assert_eq!(
            current(&settings(Setup::AnthropicApi)),
            api(Setup::AnthropicApi, "claude-x")
        );
        assert_eq!(
            current(&settings(Setup::OpenaiApi)),
            api(Setup::OpenaiApi, "gpt-x")
        );
        assert_eq!(
            current(&settings(Setup::ClaudeSubscription)),
            claude("opus", "high")
        );
    }

    #[test]
    fn api_effort_is_the_one_remembered_for_the_model_of_that_option() {
        let mut now = settings(Setup::OpencodeGo);
        let go = &mut now.api_options.opencode_go.efforts;
        go.insert("glm-5.3".into(), "high".into());
        go.insert("kimi-k3".into(), "max".into());
        // Another option's effort for the same model name is not used.
        now.api_options
            .openai_api
            .efforts
            .insert("glm-5.3".into(), "low".into());
        let mut expected = opencode("glm-5.3");
        expected.effort = Some("high".into());
        assert_eq!(current(&now), expected);
        // A follow-up keeps its session's model and uses that model's effort of now.
        let previous = job(Setup::OpencodeGo, "kimi-k3");
        let follow_up = for_follow_up(Some(&previous), Some("s1"), &now);
        assert_eq!(follow_up.effort.as_deref(), Some("max"));
        // The Claude subscription never gets an API effort.
        now.setup = Setup::ClaudeSubscription;
        assert_eq!(current(&now), claude("opus", "high"));
    }

    #[test]
    fn the_program_follows_the_setup_and_stays_with_its_session() {
        let program = opencode("glm-5.3");
        assert_eq!(program.harness, Harness::Opencode2);
        assert_eq!(
            program.describe(),
            "OpenCode Go (glm-5.3) in the OpenCode 2 program"
        );
        assert_eq!(
            api(Setup::AnthropicApi, "claude-x").describe(),
            "Anthropic Compatible API (claude-x)"
        );
        assert_eq!(
            current(&settings(Setup::ClaudeSubscription)).harness,
            Harness::ClaudeCode
        );
        // A follow-up keeps its session's program, whatever is chosen now.
        let mut previous = job(Setup::OpencodeGo, "kimi-k3");
        let follow_up = for_follow_up(Some(&previous), Some("s1"), &settings(Setup::AnthropicApi));
        assert_eq!(follow_up.harness, Harness::Opencode2);
        assert_eq!(follow_up.setup, Setup::OpencodeGo);
        // Jobs saved before the program was stored are Claude Code.
        previous.harness = None;
        assert_eq!(
            for_follow_up(Some(&previous), Some("s1"), &settings(Setup::OpencodeGo)).harness,
            Harness::ClaudeCode
        );
    }

    #[test]
    fn a_follow_up_stays_on_the_setup_of_its_session() {
        let on_api = job(Setup::OpencodeGo, "kimi-k3");
        let on_claude = job(Setup::ClaudeSubscription, "sonnet");
        let now_api = settings(Setup::OpencodeGo);
        let now_claude = settings(Setup::ClaudeSubscription);
        assert_eq!(
            for_follow_up(Some(&on_api), Some("s1"), &now_claude),
            opencode("kimi-k3")
        );
        assert_eq!(
            for_follow_up(Some(&on_claude), Some("s1"), &now_api),
            claude("opus", "high"),
            "a Claude subscription session uses the Claude model of now"
        );
        // Nothing to resume: the current selection.
        assert_eq!(
            for_follow_up(Some(&on_api), None, &now_claude),
            claude("opus", "high")
        );
        assert_eq!(for_follow_up(None, None, &now_api), opencode("glm-5.3"));
    }

    #[test]
    fn a_resumed_session_that_cannot_run_falls_back_to_the_current_selection() {
        let job = opencode("kimi-k3");
        let now = claude("opus", "high");
        let gone = Some(Problem::Api("No API key is saved for OpenCode Go.".into()));
        match choose(&job, gone.clone(), true, &now, || None) {
            Choice::SwitchTo(runner, line) => {
                assert_eq!(runner, now);
                assert_eq!(
                    line,
                    "This video's session ran on OpenCode Go (kimi-k3) in the OpenCode 2 program, which cannot continue it now (No API key is saved for OpenCode Go). A new session on the Claude subscription gets the full instructions."
                );
            }
            other => panic!("{other:?}"),
        }
        // Not resuming: the job fails with the reason.
        assert_eq!(
            choose(&job, gone.clone(), false, &now, || None),
            Choice::Fail(
                "No API key is saved for OpenCode Go. Fix it in Settings, Harness + API Keys, then press Continue Editing."
                    .into()
            )
        );
        // The current selection cannot run either: the job's own reason.
        assert!(matches!(
            choose(&job, gone, true, &now, || Some(Problem::LoggedOut(
                "x".into()
            ))),
            Choice::Fail(_)
        ));
        // A Claude session whose login is gone, while an API option is selected.
        let claude_job = claude("sonnet", "low");
        assert!(matches!(
            choose(
                &claude_job,
                Some(Problem::LoggedOut("Claude Code is logged out.".into())),
                true,
                &opencode("glm-5.3"),
                || None
            ),
            Choice::SwitchTo(r, _) if r.setup == Setup::OpencodeGo
        ));
        // Same runner: nothing to switch to.
        assert_eq!(
            choose(
                &claude_job,
                Some(Problem::LoggedOut("out".into())),
                true,
                &claude_job.clone(),
                || None
            ),
            Choice::Fail("out".into())
        );
        // Not installed: no fallback helps.
        assert_eq!(
            choose(
                &claude_job,
                Some(Problem::NotInstalled("missing".into())),
                true,
                &opencode("glm-5.3"),
                || None
            ),
            Choice::Fail("missing".into())
        );
        assert_eq!(choose(&claude_job, None, true, &now, || None), Choice::Keep);
    }

    #[test]
    fn only_api_runners_are_checked_against_their_option() {
        let setup = |key: Option<&str>| {
            opencode::ApiSetup::new(
                crate::model::ApiOption::OpencodeGo,
                &settings(Setup::OpencodeGo),
                key.map(str::to_owned),
                None,
            )
        };
        assert_eq!(
            api_problem(&opencode("glm-5.3"), &setup(None)),
            Some(Problem::Api("No API key is saved for OpenCode Go.".into()))
        );
        assert_eq!(api_problem(&opencode("glm-5.3"), &setup(Some("k"))), None);
        assert_eq!(api_problem(&claude("opus", "high"), &setup(None)), None);
    }
}

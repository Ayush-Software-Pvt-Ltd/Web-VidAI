//! The agent program that does an edit (SPEC section 7a, "The program that edits"): Claude Code
//! or the OpenCode 2 program, as the selected setup says.
//!
//! - [`for_new_job`] is the one place that decides the program of a new job.
//! - [`AgentProcess`] is what the job engine needs from a running agent, whichever program it
//!   is: both speak the same event vocabulary (`claude::session::SessionEvent`; OpenCode 2's
//!   events are translated by `opencode::harness::events2`), so only starting it differs. Claude
//!   Code is one process per run (`claude::session::Session`), OpenCode 2 one headless server per
//!   run (`opencode::harness::server2::Server2`).
//!
//! A session stays in the program it started in, like its provider and model
//! (`JobView::harness`, `jobs::runner`).

use std::io;

use crate::claude::session::Session;
use crate::model::Settings;
use crate::opencode::harness::server2::Server2;

pub use crate::model::Harness;

/// THE decision of which program does a new job: the one of the selected setup
/// (`model::Setup::harness`). Claude Code on the Claude subscription and on `anthropicApi`, the
/// OpenCode 2 program on `opencodeGo` and `openaiApi`.
pub fn for_new_job(settings: &Settings) -> Harness {
    settings.setup.harness()
}

/// What the job engine does with a running agent, whichever program it is. Events arrive through
/// the callback given when it was started.
pub trait AgentProcess: Send + Sync {
    /// The process (and process group) whose tree belongs to the job.
    fn pid(&self) -> u32;
    /// Sends one user message.
    fn send_user(&self, text: &str) -> io::Result<()>;
    /// Interrupts the running turn; the returned id comes back in a `ControlResponse`.
    fn interrupt(&self) -> io::Result<String>;
    /// Lets the agent end: Claude Code exits when its stdin closes while idle, the OpenCode
    /// server is told to end. Its `Exited` event follows. Idempotent.
    fn close(&self);
}

impl AgentProcess for Session {
    fn pid(&self) -> u32 {
        Session::pid(self)
    }

    fn send_user(&self, text: &str) -> io::Result<()> {
        Session::send_user(self, text)
    }

    fn interrupt(&self) -> io::Result<String> {
        Session::interrupt(self)
    }

    fn close(&self) {
        self.close_stdin();
    }
}

impl AgentProcess for Server2 {
    fn pid(&self) -> u32 {
        Server2::pid(self)
    }

    fn send_user(&self, text: &str) -> io::Result<()> {
        Server2::send_user(self, text)
    }

    fn interrupt(&self) -> io::Result<String> {
        Server2::interrupt(self)
    }

    fn close(&self) {
        Server2::close(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Setup;

    fn settings(setup: Setup) -> Settings {
        Settings {
            setup,
            ..Settings::default()
        }
    }

    #[test]
    fn the_program_is_the_one_of_the_selected_setup() {
        use Harness::{ClaudeCode, Opencode2};
        for (setup, program) in [
            (Setup::ClaudeSubscription, ClaudeCode),
            (Setup::AnthropicApi, ClaudeCode),
            (Setup::OpencodeGo, Opencode2),
            (Setup::OpenaiApi, Opencode2),
        ] {
            assert_eq!(for_new_job(&settings(setup)), program, "{setup:?}");
        }
    }
}

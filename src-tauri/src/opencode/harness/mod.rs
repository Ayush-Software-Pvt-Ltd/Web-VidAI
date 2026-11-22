//! The OpenCode 2 program as the agent that does an edit (SPEC section 7a, "The program that
//! edits"), next to Claude Code (`claude::session`); `harness::for_new_job` decides which one.
//!
//! The control surface is the program's headless server, one per running job, driven over its
//! HTTP API on this computer only (`opencode2 serve`, the API under `/api`):
//!
//! - [`locate2`]: finding the program, its version, and whether VidAI drives it.
//! - [`launch2`]: the command line, the environment (key, password, per-run configuration), how
//!   VidAI's address and model become the program's `provider/model`, and the session's
//!   permissions.
//! - [`events2`]: the event stream, translated into the job engine's vocabulary.
//! - [`server2`]: one running server and its session: start, send, interrupt, close.
//! - `child`: what the server is built on (the process, the local HTTP clients, the stream
//!   reader).

pub mod child;
pub mod events2;
pub mod launch2;
pub mod locate2;
pub mod server2;

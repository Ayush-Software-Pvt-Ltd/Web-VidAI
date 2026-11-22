//! Thin `#[tauri::command]` functions only: validate, call a module, map errors (SPEC section 3).
//!
//! Every command of SPEC section 5 is declared in one of these files with its final signature and
//! registered in `bindings::builder` (do not register commands anywhere else). Commands may add
//! `State<'_, T>` or `AppHandle` parameters freely: they are injected by Tauri and do not change
//! the TypeScript signature. Changing a JavaScript-visible parameter or the return type changes the
//! IPC contract: update SPEC.md, run `npm run gen:types`, and update `src/lib/ipc.ts` and the mock.

pub mod archive;
pub mod jobs;
pub mod library;
pub mod opencode;
pub mod settings;
pub mod system;

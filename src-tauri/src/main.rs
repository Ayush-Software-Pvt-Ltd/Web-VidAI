// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows: the app binary is also the picture check helper (SPEC section 11). Started as the
    // helper, it checks one video and exits here, before anything of the app starts.
    #[cfg(windows)]
    vidai_lib::platform::orientation::windows_helper::app_entry();
    vidai_lib::run()
}

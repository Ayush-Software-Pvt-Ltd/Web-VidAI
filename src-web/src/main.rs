//! `vidai-web`: the VidAI core with a local web server instead of a window (SPEC section 12).

fn main() -> std::process::ExitCode {
    vidai_web::run()
}

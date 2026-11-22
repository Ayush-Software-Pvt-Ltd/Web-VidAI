//! The command line and environment of `vidai-web`.

use std::ffi::OsString;

/// The port of the server unless `--port` or `VIDAI_WEB_PORT` says otherwise.
pub const DEFAULT_PORT: u16 = 14200;
/// The environment variable that gives the port.
pub const PORT_ENV: &str = "VIDAI_WEB_PORT";

const USAGE: &str = "\
VidAI Web: the VidAI core with a local web server for a browser on this computer.

Usage: vidai-web [--port <n>] [--no-open]

  --port <n>   Port on 127.0.0.1 (default 14200, or VIDAI_WEB_PORT). 0 lets the system pick one.
  --no-open    Do not open the browser.
  -h, --help   Show this help.
";

/// What the command line asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The port on 127.0.0.1; 0 means any free port.
    pub port: u16,
    /// Whether to open the address in the default browser once the core is up.
    pub open_browser: bool,
}

/// What to do with the command line.
#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Run(Options),
    /// Print this text on stdout and exit with status 0.
    Help(&'static str),
}

/// Reads the options from the arguments (without the program name) and the value of
/// `VIDAI_WEB_PORT` (the flag wins). The error is a message for the user.
pub fn parse<I>(args: I, env_port: Option<&str>) -> Result<Parsed, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut port = match env_port.map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => parse_port(value).map_err(|e| format!("{PORT_ENV}: {e}"))?,
        None => DEFAULT_PORT,
    };
    let mut open_browser = true;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let arg = arg
            .into_string()
            .map_err(|raw| format!("unreadable argument {raw:?}"))?;
        match arg.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help(USAGE)),
            "--no-open" => open_browser = false,
            "--port" => {
                let value = args
                    .next()
                    .and_then(|v| v.into_string().ok())
                    .ok_or("--port needs a number")?;
                port = parse_port(&value).map_err(|e| format!("--port: {e}"))?;
            }
            other => match other.strip_prefix("--port=") {
                Some(value) => port = parse_port(value).map_err(|e| format!("--port: {e}"))?,
                None => return Err(format!("unknown argument {other:?}\n\n{USAGE}")),
            },
        }
    }
    Ok(Parsed::Run(Options { port, open_browser }))
}

fn parse_port(text: &str) -> Result<u16, String> {
    text.trim()
        .parse::<u16>()
        .map_err(|_| format!("{text:?} is not a port number (0 to 65535)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str], env: Option<&str>) -> Result<Parsed, String> {
        parse(args.iter().map(OsString::from), env)
    }

    fn options(port: u16, open_browser: bool) -> Result<Parsed, String> {
        Ok(Parsed::Run(Options { port, open_browser }))
    }

    #[test]
    fn the_defaults() {
        assert_eq!(run(&[], None), options(14200, true));
        assert_eq!(run(&[], Some("  ")), options(14200, true));
    }

    #[test]
    fn the_flag_wins_over_the_environment() {
        assert_eq!(run(&[], Some("15000")), options(15000, true));
        assert_eq!(
            run(&["--port", "16000"], Some("15000")),
            options(16000, true)
        );
        assert_eq!(run(&["--port=0", "--no-open"], None), options(0, false));
    }

    #[test]
    fn mistakes_are_explained() {
        assert!(
            run(&["--port"], None)
                .unwrap_err()
                .contains("needs a number")
        );
        assert!(
            run(&["--port", "70000"], None)
                .unwrap_err()
                .contains("70000")
        );
        assert!(
            run(&[], Some("abc"))
                .unwrap_err()
                .starts_with("VIDAI_WEB_PORT")
        );
        assert!(run(&["--nope"], None).unwrap_err().contains("--nope"));
    }

    #[test]
    fn help_is_not_a_failure() {
        assert!(matches!(run(&["--help"], None), Ok(Parsed::Help(_))));
    }
}

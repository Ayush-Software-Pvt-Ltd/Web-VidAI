//! Who may talk to the server: the access token and cookie, the `Host` and `Origin` checks and
//! the headers of every answer (SPEC section 12, Server).

mod support;

use serde_json::{Value, json};
use support::Server;

/// The security headers every answer carries.
fn assert_security_headers(response: &support::Response, what: &str) {
    let csp = response
        .header("content-security-policy")
        .unwrap_or_else(|| panic!("{what}: no Content-Security-Policy"));
    assert!(csp.contains("default-src 'self'"), "{what}: {csp}");
    assert!(
        !csp.contains("ipc:") && !csp.contains("asset:"),
        "{what}: {csp}"
    );
    assert_eq!(
        response.header("x-content-type-options").as_deref(),
        Some("nosniff"),
        "{what}"
    );
    assert_eq!(
        response.header("referrer-policy").as_deref(),
        Some("no-referrer"),
        "{what}"
    );
}

#[test]
fn the_address_has_a_token_that_is_kept_in_the_data_directory() {
    let data = tempfile::tempdir().unwrap();
    let first = Server::start_in(data.path());
    assert_eq!(first.token.len(), 64);
    assert!(
        first
            .token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    );
    let file = data.path().join("web-token");
    assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), first.token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // A restart on the same data directory keeps the token; another directory has its own.
    let token = first.token.clone();
    first.stop();
    let again = Server::start_in(data.path());
    assert_eq!(again.token, token);
    assert_ne!(Server::start().token, token);
}

#[test]
fn without_the_cookie_nothing_is_served() {
    let server = Server::start();
    for (method, path) in [
        ("GET", "/"),
        ("GET", "/index.html"),
        ("GET", "/vidai-env.js"),
        ("GET", "/assets/index.js"),
        ("GET", "/some/page"),
        ("POST", "/"),
    ] {
        let response = server.anonymous(method, path, "", &[]);
        assert_eq!(response.status, 401, "{method} {path}");
        assert_eq!(
            response.header("content-type").as_deref(),
            Some("text/html; charset=utf-8"),
            "{method} {path}"
        );
        assert!(
            response.body.contains("vidai-web"),
            "{path}: {}",
            response.body
        );
        assert!(response.body.contains("prefers-color-scheme"), "{path}");
        assert!(!response.body.contains('\u{2014}'));
        assert_eq!(
            response.header("cache-control").as_deref(),
            Some("no-store")
        );
        assert_security_headers(&response, path);
    }
    // Under /api/ the answer is JSON.
    for (method, path) in [
        ("POST", "/api/invoke/get_settings"),
        ("GET", "/api/events"),
        ("POST", "/api/fs/list"),
        ("GET", "/api/asset?path=/etc/hosts"),
    ] {
        let response = server.anonymous(method, path, "{}", &[]);
        assert_eq!(response.status, 401, "{method} {path}");
        let value: Value = serde_json::from_str(&response.body).expect("JSON");
        assert_eq!(value["kind"], "unauthorized", "{path}");
        assert!(
            value["message"]
                .as_str()
                .is_some_and(|m| m.contains("vidai-web"))
        );
        assert_eq!(
            response.header("content-type").as_deref(),
            Some("application/json")
        );
    }
}

#[test]
fn a_wrong_cookie_is_refused() {
    let server = Server::start();
    let wrong = "0".repeat(64);
    let almost = format!(
        "{}{}",
        &server.token[..63],
        if server.token.ends_with('0') {
            '1'
        } else {
            '0'
        }
    );
    for cookie in [
        format!("vidai_web={wrong}"),
        format!("vidai_web={almost}"),
        format!("vidai_web={}", &server.token[..32]),
        format!("vidai_web={}x", server.token),
        "vidai_web=".to_owned(),
        format!("other={}", server.token),
        format!("xvidai_web={}", server.token),
    ] {
        let response = server.anonymous(
            "POST",
            "/api/invoke/get_settings",
            "{}",
            &[("Cookie", &cookie)],
        );
        assert_eq!(response.status, 401, "{cookie}");
    }
    // The right cookie among others is found.
    let cookie = format!("a=1; vidai_web={}; b=2", server.token);
    let response = server.anonymous(
        "POST",
        "/api/invoke/get_settings",
        "{}",
        &[("Cookie", &cookie)],
    );
    assert_eq!(response.status, 200);
}

#[test]
fn a_wrong_token_in_the_address_is_refused_not_redirected() {
    let server = Server::start();
    let wrong = "f".repeat(64);
    for query in [
        format!("?token={wrong}"),
        "?token=".to_owned(),
        "?token".to_owned(),
        format!("?token={}x", server.token),
        format!("?token={}", &server.token[..63]),
    ] {
        let response = server.anonymous("GET", &format!("/{query}"), "", &[]);
        assert_eq!(response.status, 401, "{query}");
        assert!(response.header("set-cookie").is_none(), "{query}");
        assert!(response.header("location").is_none(), "{query}");
    }
    // The token counts only on `GET /`.
    let right = &server.token;
    for (method, path) in [
        ("GET", format!("/page?token={right}")),
        ("POST", format!("/?token={right}")),
    ] {
        let response = server.anonymous(method, &path, "", &[]);
        assert_eq!(response.status, 401, "{method} {path}");
        assert!(response.header("set-cookie").is_none());
    }
}

#[test]
fn the_right_token_sets_the_cookie_and_redirects_to_the_plain_address() {
    let server = Server::start();
    let response = server.anonymous("GET", &format!("/?token={}", server.token), "", &[]);
    assert_eq!(response.status, 303);
    assert_eq!(response.header("location").as_deref(), Some("/"));
    assert_eq!(
        response.header("cache-control").as_deref(),
        Some("no-store")
    );
    let cookie = response.header("set-cookie").expect("a cookie");
    let mut parts = cookie.split("; ");
    assert_eq!(
        parts.next(),
        Some(format!("vidai_web={}", server.token).as_str())
    );
    let rest: Vec<&str> = parts.collect();
    for attribute in ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=31536000"] {
        assert!(rest.contains(&attribute), "{attribute} in {cookie}");
    }
    assert_security_headers(&response, "redirect");

    // The cookie it gave is enough for everything else, with no token in the address.
    let own = format!("vidai_web={}", server.token);
    let answer = server.anonymous(
        "POST",
        "/api/invoke/get_settings",
        "{}",
        &[("Cookie", &own)],
    );
    assert_eq!(answer.status, 200);
    let (status, settings) = server.invoke("get_settings", &json!({}));
    assert_eq!(
        (status, &settings["setup"]),
        (200, &json!("claudeSubscription"))
    );
}

#[test]
fn only_the_servers_own_host_is_answered() {
    let server = Server::start();
    let port = server.port;
    let good = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("LOCALHOST:{port}"),
    ];
    for host in &good {
        assert_eq!(
            server
                .request("GET", "/vidai-env.js", "", &[("Host", host)])
                .status,
            200,
            "{host}"
        );
    }
    let bad = [
        format!("evil.example:{port}"),
        "evil.example".to_owned(),
        "127.0.0.1".to_owned(),
        "localhost".to_owned(),
        format!("127.0.0.1:{}", port.wrapping_add(1)),
        format!("127.0.0.1:{port}.evil.example"),
        format!("localhost.evil.example:{port}"),
        format!("[::1]:{port}"),
        format!("192.168.1.5:{port}"),
        String::new(),
    ];
    for host in &bad {
        // Even with the cookie, and before the token is looked at (without it).
        let with_cookie = server.request("GET", "/vidai-env.js", "", &[("Host", host)]);
        assert_eq!(with_cookie.status, 403, "{host:?}");
        let without = server.anonymous("GET", "/", "", &[("Host", host)]);
        assert_eq!(
            without.status, 403,
            "{host:?} without the cookie is 403, not 401"
        );
        let right_token = server.anonymous(
            "GET",
            &format!("/?token={}", server.token),
            "",
            &[("Host", host)],
        );
        assert_eq!(
            right_token.status, 403,
            "{host:?} must not give out the cookie"
        );
        assert!(right_token.header("set-cookie").is_none());
        assert_security_headers(&with_cookie, host);
    }
    // Under /api/ the refusal is JSON.
    let response = server.request(
        "POST",
        "/api/invoke/get_settings",
        "{}",
        &[("Host", "evil.example:1")],
    );
    assert_eq!(response.status, 403);
    let value: Value = serde_json::from_str(&response.body).unwrap();
    assert_eq!(value["kind"], "forbidden");
    // A request with two Host headers is not trusted either.
    let twice = server.request(
        "GET",
        "/vidai-env.js",
        "",
        &[
            ("Host", &format!("127.0.0.1:{port}")),
            ("Host", "evil.example"),
        ],
    );
    assert_eq!(twice.status, 403);
}

#[test]
fn only_the_servers_own_origin_is_answered() {
    let server = Server::start();
    let port = server.port;
    for origin in [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ] {
        let response = server.request(
            "POST",
            "/api/invoke/get_settings",
            "{}",
            &[("Origin", &origin)],
        );
        assert_eq!(response.status, 200, "{origin}");
    }
    for origin in [
        "http://evil.example".to_owned(),
        format!("http://evil.example:{port}"),
        format!("https://127.0.0.1:{port}"),
        format!("http://127.0.0.1:{}", port.wrapping_add(1)),
        "null".to_owned(),
        String::new(),
    ] {
        for (method, path) in [
            ("POST", "/api/invoke/get_settings"),
            ("GET", "/vidai-env.js"),
            ("GET", "/api/events"),
        ] {
            let response = server.request(method, path, "{}", &[("Origin", &origin)]);
            assert_eq!(response.status, 403, "{method} {path} from {origin:?}");
        }
        // Before the token: a page of another site learns nothing, not even that it is refused
        // for lack of a cookie.
        let response = server.anonymous(
            "POST",
            "/api/invoke/get_settings",
            "{}",
            &[("Origin", &origin)],
        );
        assert_eq!(response.status, 403, "{origin:?}");
    }
}

#[test]
fn answers_carry_the_security_headers_and_api_answers_are_not_cached() {
    let server = Server::start();
    for path in ["/", "/vidai-env.js", "/some/page", "/missing.png"] {
        assert_security_headers(&server.get(path), path);
    }
    let invoke = server.request("POST", "/api/invoke/get_settings", "{}", &[]);
    assert_security_headers(&invoke, "invoke");
    assert_eq!(invoke.header("cache-control").as_deref(), Some("no-store"));
    let failed = server.request("POST", "/api/invoke/no_such_command", "{}", &[]);
    assert_eq!(failed.header("cache-control").as_deref(), Some("no-store"));
    let unknown = server.get("/api/no-such-route");
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.header("cache-control").as_deref(), Some("no-store"));
    // The stream (read only up to its head).
    let events = support::Events::open(&server);
    let _ = events.next();
}

#[test]
fn the_event_stream_needs_the_cookie_too() {
    let server = Server::start();
    let response = server.anonymous("GET", "/api/events", "", &[]);
    assert_eq!(response.status, 401);
    let events = support::Events::open(&server);
    assert_eq!(events.next().0, "vidai-web://hello");
}

#[test]
fn a_file_of_the_editing_folder_keeps_its_sandbox_policy() {
    let server = Server::start();
    let folder = tempfile::tempdir().unwrap();
    std::fs::write(
        folder.path().join("page.svg"),
        "<svg xmlns='http://www.w3.org/2000/svg'/>",
    )
    .unwrap();
    let (status, _) = server.invoke("set_editing_folder", &json!({ "path": folder.path() }));
    assert_eq!(status, 200);
    let path = folder.path().join("page.svg");
    let target = format!(
        "/api/asset?path={}",
        path.to_str().unwrap().replace('/', "%2F")
    );
    let response = server.get(&target);
    assert_eq!(response.status, 200, "{}", response.head);
    let csp = response
        .header("content-security-policy")
        .expect("a policy");
    assert!(
        csp.starts_with("sandbox;") && csp.contains("default-src 'none'"),
        "{csp}"
    );
    assert!(!csp.contains("'self'"), "{csp}");
    assert_eq!(
        response.header("x-content-type-options").as_deref(),
        Some("nosniff")
    );
    // The pages of the UI get the page policy.
    let page = server.get("/");
    let csp = page.header("content-security-policy").expect("a policy");
    assert!(
        csp.contains("default-src 'self'") && !csp.contains("sandbox"),
        "{csp}"
    );
}

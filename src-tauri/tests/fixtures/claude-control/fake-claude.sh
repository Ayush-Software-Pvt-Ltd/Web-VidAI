#!/bin/sh
# A fake `claude` for tests: answers `--version`, `auth status`, and the control requests
# `initialize`, `get_settings` and `get_usage` with the recorded fixtures in this folder.
# It never contacts anything. Behaviour switches (environment):
#   FAKE_CLAUDE_FIXTURES   folder with the fixtures (required)
#   FAKE_CLAUDE_LOG        file that gets one line per start: the working folder and arguments
#   FAKE_CLAUDE_LOGGED_OUT when set, `auth status` reports loggedIn false (and exits 1)
#   FAKE_CLAUDE_SILENT     a request subtype that is never answered
#   FAKE_CLAUDE_EXIT_ON    a request subtype on which the process exits with an error
#   FAKE_CLAUDE_EXIT_ONCE  a file; when it exists at a request, it is removed and the process
#                          exits with an error (a helper that dies once)

dir="${FAKE_CLAUDE_FIXTURES:?FAKE_CLAUDE_FIXTURES is not set}"

if [ -n "$FAKE_CLAUDE_LOG" ]; then
  printf 'start cwd=%s args=%s\n' "$(pwd)" "$*" >>"$FAKE_CLAUDE_LOG"
fi

case "$1" in
  --version)
    echo "2.1.319 (Claude Code)"
    exit 0
    ;;
  auth)
    if [ -n "$FAKE_CLAUDE_LOGGED_OUT" ]; then
      cat "$dir/auth_status_logged_out.json"
      exit 1
    fi
    cat "$dir/auth_status.json"
    exit 0
    ;;
esac

# Control mode. Startup noise that a real client must ignore:
echo "this line is not JSON"
echo '{"type":"system","subtype":"status","status":"starting"}'

answer() { # request_id, fixture file
  printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":%s}}\n' \
    "$1" "$(tr -d '\n' <"$dir/$2")"
}

while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  subtype=$(printf '%s' "$line" | sed -n 's/.*"subtype":"\([^"]*\)".*/\1/p')
  if [ -n "$FAKE_CLAUDE_LOG" ]; then
    printf 'request %s\n' "$subtype" >>"$FAKE_CLAUDE_LOG"
  fi
  if [ "$subtype" = "$FAKE_CLAUDE_SILENT" ]; then
    continue
  fi
  if [ -n "$FAKE_CLAUDE_EXIT_ONCE" ] && [ -f "$FAKE_CLAUDE_EXIT_ONCE" ]; then
    rm -f "$FAKE_CLAUDE_EXIT_ONCE"
    echo "Error: fake claude died" >&2
    exit 4
  fi
  if [ "$subtype" = "$FAKE_CLAUDE_EXIT_ON" ]; then
    echo "Error: fake claude stopped on $subtype" >&2
    exit 3
  fi
  case "$subtype" in
    initialize) answer "$id" initialize.json ;;
    get_settings) answer "$id" get_settings.json ;;
    get_usage) answer "$id" get_usage.json ;;
    *)
      printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"Unsupported control request subtype: %s"}}\n' \
        "$id" "$subtype"
      ;;
  esac
done
exit 0

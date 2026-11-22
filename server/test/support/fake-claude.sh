#!/bin/sh
# A fake Claude Code for the job engine integration tests (server/test/jobs/engine.test.js).
#
# It speaks the stream-json protocol of `claude -p --input-format stream-json
# --output-format stream-json` closely enough for the job manager, following the recordings in
# server/test/support/fixtures/claude-stream/. FAKE_STATE is a directory where every call records its
# arguments, environment (the OpenCode variables) and stdin, and where tests leave
# signals (release files).
# The working directory is the Editing Folder, as with the real Claude Code.
#
# The scenario is FAKE_SCENARIO; without it, the content of the file FAKE_STATE/scenario.<video
# folder> or FAKE_STATE/scenario, else "complete". Scenarios: complete, background, slow,
# no_output, usage_limit, quiet_limit, resume_missing, tree, crash, echo_key, hold, live, logged_out, render
# (complete, writing a final render instead of a review project), progress (complete, one step
# at a time, and with a final render for a render request), premature, spin, api_error.
#
# premature is complete with turns that end early, the way some models on OpenCode do: after the
# steps listed in FAKE_STATE/stops.<video folder> (or FAKE_STATE/stops; numbers separated by
# spaces, 0 = before the first step) the turn ends with only a sentence that announces the next
# step: no tool call, no marker. The fake then waits, in the same process, for the next message
# and goes on with the next step; a stop after the last step leaves out [OUTPUT COMPLETED] until
# the next message. Each turn that ends early drops FAKE_STATE/ended.<video folder>.<n>, and each
# message that brings it back FAKE_STATE/continued.<video folder>.<n>. With FAKE_STATE/gate.<video
# folder> it then waits for FAKE_STATE/release.<video folder> (used up) before it goes on, and a
# pause interrupts it there. A resumed session goes on after the last finished step, and a stop
# that happened before is not repeated.
# spin is a model that is busy but gets nowhere: every turn makes one tool call and ends.
# api_error does the first three steps of an edit, then ends its turn with the API error Claude
# Code reports after its own retries (an OpenCode Go weekly limit, HTTP 429); with the file
# FAKE_STATE/api_error_quiet the result does not say is_error.
# model_error fails the first N processes of a video with the HTTP 529 (overloaded) error result
# Claude Code reports after its own retries, then works like complete; N is the content of
# FAKE_STATE/model_errors (default 2), the failures so far are counted in
# FAKE_STATE/model_error_count.<video folder>.
# batched is progress as the real OpenCode models work: the markers are held back and written all
# together, in one message, right before [OUTPUT COMPLETED]; the tool calls say nothing about
# which step they are (no Whisper, graphics or QA words, no sub-agent), so only the files tell:
# each step leaves the files a real edit leaves in the video folder (the audio, the transcript,
# the plan, the graphics sources and renders, the quality-check sheet, then the review project,
# thumbnail and meta.txt of the output folder).
# no_output answers every further message of the same process the same way, without any work.
#
# complete works through the steps of a real job of the requested kind (edit, re-edit or render)
# with the tool calls, sub-agents and progress markers ([VIDAI_PROGRESS <name>]) a real edit shows.
# The review project it saves is the one of the edit's REVIEW_OUTPUT_SOFTWARE: <video>_vN.fcpxml
# for Final Cut Pro, a Premiere Pro XML <video>_vN.xml for Premiere Pro (remembered per session).
# progress does the same but stops after each step: it writes the number of finished steps to
# FAKE_STATE/reached.<video folder> and waits until the test drops FAKE_STATE/next.<video folder>
# (used up); a pause interrupts it there, and a continued session goes on with the next step.
#
# Every wait blocks on an event instead of polling, so many fakes running at once cost nothing
# while they wait: stdin is read with blocking reads, and the other waits sleep on the FIFO
# FAKE_STATE/wake.<pid>, which gets a line when stdin brings an interrupt or closes, and when the
# test drops one of its files (the tests write a line into every wake.* FIFO after that; without
# it, as in the end-to-end runs, a dropped file is noticed within a second). Each check uses
# shell builtins only. A fake whose FAKE_STATE folder is gone (the test ended, also by failing)
# or whose stdin is closed ends by itself, so it never outlives its test.
#
# In Git Bash (Windows) there is no wake-up FIFO: nothing outside MSYS2 can write into one, and
# MSYS2's emulated FIFOs can hang a fake for good when several fakes create and open theirs at
# the same moment (an integration test that started three edits at once stopped right after
# sending the instructions). There each wait is a plain one-second sleep.
#
# Other switches: the file FAKE_STATE/logged_out makes `auth status` report a logged-out Claude
# Code and every session without ANTHROPIC_API_KEY behave like the logged_out scenario. The file FAKE_STATE/no_markers
# leaves out the progress markers (the steps and tool calls stay). A process started without a
# session (the control-request helper of `claude::control`) is handed to the fake of
# tests/fixtures/claude-control, found through FAKE_CLAUDE_FIXTURES.

set -u

ST="${FAKE_STATE:-}"
logged_out() { [ -n "$ST" ] && [ -e "$ST/logged_out" ]; }

case "${1:-}" in
  --version) echo "2.1.319 (Claude Code)"; exit 0 ;;
  auth)
    if logged_out; then echo '{"loggedIn":false}'; exit 1; fi
    echo '{"loggedIn":true}'; exit 0 ;;
esac

ALL_ARGS="$*"
MODE=new
SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) MODE=new; SID="$2"; shift ;;
    --resume) MODE=resume; SID="$2"; shift ;;
  esac
  shift
done

if [ -z "$SID" ]; then
  # The control-request helper (no session): answered by the control fake.
  exec /bin/sh "${FAKE_CLAUDE_FIXTURES:?FAKE_CLAUDE_FIXTURES is not set}/fake-claude.sh" "$@"
fi

ST="$FAKE_STATE"
ME=$$
IN="$ST/in.$ME"
: > "$IN"
{
  printf 'mode=%s\n' "$MODE"
  printf 'sid=%s\n' "$SID"
  printf 'args=%s\n' "$ALL_ARGS"
  printf 'cwd=%s\n' "$PWD"
  printf 'ANTHROPIC_BASE_URL=%s\n' "${ANTHROPIC_BASE_URL-<unset>}"
  printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY-<unset>}"
  printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "${ANTHROPIC_AUTH_TOKEN-<unset>}"
  printf 'ANTHROPIC_DEFAULT_OPUS_MODEL=%s\n' "${ANTHROPIC_DEFAULT_OPUS_MODEL-<unset>}"
  printf 'ANTHROPIC_DEFAULT_SONNET_MODEL=%s\n' "${ANTHROPIC_DEFAULT_SONNET_MODEL-<unset>}"
  printf 'ANTHROPIC_DEFAULT_HAIKU_MODEL=%s\n' "${ANTHROPIC_DEFAULT_HAIKU_MODEL-<unset>}"
} > "$ST/call.$ME"
echo "$ME" >> "$ST/calls"

# The first user message is read here with blocking reads; a close before it ends the fake.
MESSAGE=""
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$IN"
  case "$line" in *'"type":"user"'*) MESSAGE="$line"; break ;; esac
done
[ -n "$MESSAGE" ] || exit 0

# The wake-up FIFO, open for reading and writing (so opening never blocks and reading never
# sees an end), and removed when the fake ends. None in Git Bash (see the top of this file).
case "${OSTYPE:-}" in
  msys* | cygwin*) WAKE="" ;;
  *)
    WAKE="$ST/wake.$ME"
    mkfifo "$WAKE"
    exec 4<>"$WAKE"
    trap 'rm -f "$WAKE"' EXIT ;;
esac
# Wakes the waiting script (the reader below, after an interrupt or the end of stdin).
wake() { [ -z "$WAKE" ] || echo >&4; }

# The rest of stdin is read in the background so the script can notice an interrupt
# ($IN.interrupt) and the close of stdin ($IN.eof, and the reader exits); both wake the script.
# A non-interactive shell gives background jobs /dev/null as stdin unless it is redirected
# explicitly.
exec 3<&0
(
  GOT_LINES=0
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$IN"
    case "$line" in
      *'"control_request"'*) : > "$IN.interrupt"; wake ;;
      *'"type":"user"'*) GOT_LINES=$((GOT_LINES + 1)); printf '%s\n' "$line" > "$IN.msg.$GOT_LINES"; wake ;;
    esac
  done
  : > "$IN.eof"
  wake
) <&3 &
READER=$!
exec 3<&-

out() { printf '%s\n' "$1"; }
# Waits for the next wake-up, at most a second (bash 3.2, the macOS /bin/sh, takes whole seconds).
nap() {
  if [ -n "$WAKE" ]; then IFS= read -r -t 1 _ <&4 || :; else sleep 1; fi
}
# Stdin was closed, or the test is gone (its FAKE_STATE folder with it).
is_eof() { [ -e "$IN.eof" ] || [ ! -d "$ST" ]; }
interrupted() { [ -e "$IN.interrupt" ]; }
# Blocks until stdin is closed: the reader ends exactly then.
wait_eof() { wait "$READER"; }

# Waits, idle, for the next user message of this process (the reader numbers them from 1). An
# interrupt while idle is answered like the real Claude Code does (no turn to end), then the
# fake waits for stdin to close. Returns 1 when stdin closes.
FOLLOW_UPS=0
next_message() {
  n=$((FOLLOW_UPS + 1))
  while [ ! -e "$IN.msg.$n" ]; do
    if interrupted; then
      RID=$(grep -m 1 '"control_request"' "$IN" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
      out '{"type":"control_response","response":{"subtype":"success","request_id":"'"$RID"'","response":{"still_queued":[]}}}'
      wait_eof
      return 1
    fi
    is_eof && return 1
    nap
  done
  FOLLOW_UPS=$n
  return 0
}

# Remember which video a session belongs to and its review software (resumed sessions only get
# a short follow-up).
MAIN=$(printf '%s' "$MESSAGE" | sed -n 's/.*MAIN_FOLDER = \([^\\]*\)\\n.*/\1/p')
CHANNEL=$(printf '%s' "$MESSAGE" | sed -n 's/.*CHANNEL_FOLDER = \([^\\]*\)\\n.*/\1/p')
SOFTWARE=$(printf '%s' "$MESSAGE" | sed -n 's/.*REVIEW_OUTPUT_SOFTWARE = \([^\\]*\)\\n.*/\1/p')
if [ -n "$MAIN" ]; then
  printf '%s\n%s\n%s\n' "$CHANNEL" "$MAIN" "$SOFTWARE" > "$ST/session.$SID"
elif [ -f "$ST/session.$SID" ]; then
  CHANNEL=$(sed -n 1p "$ST/session.$SID")
  MAIN=$(sed -n 2p "$ST/session.$SID")
  SOFTWARE=$(sed -n 3p "$ST/session.$SID")
fi
VDIR="$PWD/$CHANNEL/$MAIN"

SCENARIO="${FAKE_SCENARIO:-}"
if [ -z "$SCENARIO" ]; then
  if [ -n "$MAIN" ] && [ -f "$ST/scenario.$MAIN" ]; then
    SCENARIO=$(cat "$ST/scenario.$MAIN")
  elif [ -f "$ST/scenario" ]; then
    SCENARIO=$(cat "$ST/scenario")
  fi
fi
SCENARIO="${SCENARIO:-complete}"
# A session with its own key (ANTHROPIC_API_KEY) or token (ANTHROPIC_AUTH_TOKEN, the placeholder of an
# Anthropic Compatible API without a key) needs no Claude login.
if logged_out && [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then SCENARIO=logged_out; fi

init() {
  out '{"type":"system","subtype":"init","cwd":"'"$PWD"'","session_id":"'"$SID"'","model":"claude-fake-1","permissionMode":"bypassPermissions"}'
}

result() { # $1 = text, $2 = num_turns, $3 = cost
  out '{"type":"result","subtype":"success","is_error":false,"num_turns":'"$2"',"result":"'"$1"'","session_id":"'"$SID"'","total_cost_usd":'"$3"',"terminal_reason":"completed"}'
}

write_review() {
  mkdir -p "$VDIR/output"
  # The render scenario writes a final render instead of a review project, and so does the
  # progress and premature scenarios for a render request. The complete scenario writes a review project even
  # then, so a render can finish without its final file.
  case "$SCENARIO:$MESSAGE" in
    render:* | progress:*"Create the final output render"* | premature:*"Create the final output render"*)
      : > "$VDIR/output/${MAIN}_final.mp4"
      return ;;
  esac
  # The review project the real flow saves for the edit's software (SPEC section 2): an FCPXML
  # document for Final Cut Pro, a Premiere Pro XML (xmeml, which VidAI recognizes by its first
  # 4 KB) for Premiere Pro.
  case "$SOFTWARE" in
    "Premiere Pro")
      n=$(ls "$VDIR/output" 2>/dev/null | grep -c '\.xml$')
      n=$((n + 1))
      printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE xmeml>' \
        '<xmeml version="4"><sequence><name>'"$MAIN"'</name></sequence></xmeml>' \
        > "$VDIR/output/${MAIN}_v$n.xml" ;;
    *)
      n=$(ls "$VDIR/output" 2>/dev/null | grep -c '\.fcpxml$')
      n=$((n + 1))
      printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE fcpxml>' \
        '<fcpxml version="1.11"><resources/><library/></fcpxml>' \
        > "$VDIR/output/${MAIN}_v$n.fcpxml" ;;
  esac
}

# Answers the first interrupt like the real Claude Code, then waits for stdin to close.
answer_interrupt() {
  RID=$(grep -m 1 '"control_request"' "$IN" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  out '{"type":"control_response","response":{"subtype":"success","request_id":"'"$RID"'","response":{"still_queued":[]}}}'
  out '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null}'
  out '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"terminal_reason":"aborted_streaming","errors":["[ede_diagnostic] result_type=user"],"total_cost_usd":0.1}'
  wait_eof
}

# ----- the steps of a real job (complete and progress) -----

say() { # $1 = text (JSON-escaped)
  out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$1"'"}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
}

marker() { # $1 = milestone name
  [ -e "$ST/no_markers" ] && return 0
  if [ -n "$BATCH" ]; then
    printf '%s\n' "$1" >> "$ST/pending.$MAIN"
  else
    say "[VIDAI_PROGRESS $1]"
  fi
}

# Writes the held-back markers in one message (batched).
flush_markers() {
  [ -f "$ST/pending.$MAIN" ] || return 0
  text=""
  while IFS= read -r name; do
    text="${text}[VIDAI_PROGRESS $name]\\n"
  done < "$ST/pending.$MAIN"
  rm -f "$ST/pending.$MAIN"
  say "${text}All done."
}

# batched: a file of a real edit, in the working folder of the video.
work_file() { # $1 = path below CLAUDE_VE
  mkdir -p "$VE/$(dirname "$1")"
  : > "$VE/$1"
}

tool() { # $1 = id, $2 = tool name, $3 = input JSON, $4 = result text
  out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"'"$1"'","name":"'"$2"'","input":'"$3"'}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
  out '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"'"$1"'","type":"tool_result","content":"'"$4"'","is_error":false}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
}

bash_tool() { # $1 = id, $2 = command, $3 = description, $4 = result text
  if [ -n "$BATCH" ]; then tool "$1" Bash '{"command":"true","description":"Run the next step"}' "ok"; return; fi
  tool "$1" Bash '{"command":"'"$2"'","description":"'"$3"'"}' "$4"
}

# A background sub-agent: launched, then started and finished like the real Claude Code reports.
agent() { # $1 = id, $2 = description
  [ -n "$BATCH" ] && return 0
  tool "$1" Agent '{"description":"'"$2"'","prompt":"Build it.","subagent_type":"general-purpose","run_in_background":true}' "Async agent launched successfully."
  out '{"type":"system","subtype":"task_started","task_id":"task-'"$1"'","tool_use_id":"'"$1"'","description":"'"$2"'","task_type":"local_agent","is_backgrounded":true}'
  out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"'"$1"'-n","name":"Bash","input":{"command":"npx hyperframes render","description":"Render a composition"}}]},"parent_tool_use_id":"'"$1"'","session_id":"'"$SID"'"}'
  out '{"type":"system","subtype":"task_notification","task_id":"task-'"$1"'","tool_use_id":"'"$1"'","status":"completed","summary":"'"$2"' finished"}'
}

# Between steps: the progress scenario stops until the test lets it go on.
PACED=""
case "$SCENARIO" in progress | batched) PACED=1 ;; esac
BATCH=""
[ "$SCENARIO" = batched ] && BATCH=1
# The scenarios that go on after the last finished step of an earlier process of the session.
RESUMES_STEPS=""
case "$SCENARIO" in progress | premature | batched) RESUMES_STEPS=1 ;; esac

# premature: the steps after which a turn ends early.
STOPS=""
if [ "$SCENARIO" = premature ]; then
  if [ -f "$ST/stops.$MAIN" ]; then STOPS=$(cat "$ST/stops.$MAIN"); elif [ -f "$ST/stops" ]; then STOPS=$(cat "$ST/stops"); fi
fi
EARLY=0
# Ends the turn early after step $1 when it is listed (once per session), then waits for the
# next message in this process. Exits when stdin closes or a pause comes in meanwhile.
maybe_stop() {
  case " $STOPS " in *" $1 "*) ;; *) return 0 ;; esac
  [ -e "$ST/stopped.$MAIN.$1" ] && return 0
  : > "$ST/stopped.$MAIN.$1"
  say "Step $1 checked. Moving on to the next part now."
  result "Step $1 checked. Moving on to the next part now." 1 0.05
  EARLY=$((EARLY + 1))
  k=$(ls "$ST" | grep -c -F "ended.$MAIN.")
  : > "$ST/ended.$MAIN.$((k + 1))"
  next_message || exit 0
  k=$(ls "$ST" | grep -c -F "continued.$MAIN.")
  : > "$ST/continued.$MAIN.$((k + 1))"
  if [ -e "$ST/gate.$MAIN" ]; then
    while [ ! -e "$ST/release.$MAIN" ]; do
      if interrupted; then answer_interrupt; exit 0; fi
      is_eof && exit 0
      nap
    done
    rm -f "$ST/release.$MAIN"
  fi
  init
}
pace() { # $1 = number of finished steps
  [ -n "$PACED" ] || return 0
  echo "$1" > "$ST/step.$MAIN"
  echo "$1" > "$ST/reached.$MAIN"
  while [ ! -e "$ST/next.$MAIN" ]; do
    if interrupted; then answer_interrupt; exit 0; fi
    is_eof && exit 0
    nap
  done
  rm -f "$ST/next.$MAIN"
}

VE="$VDIR/CLAUDE_VE"

edit_step() { # $1 = step number
  case "$1" in
    1)
      tool r1 Read '{"file_path":"'"$PWD"'/MEMORY.md"}' "120 lines"
      bash_tool s1 "ffprobe -v error -show_streams A-roll.mov" "Inspect the A-roll" "1080x1920, 25 fps, 92 s"
      [ -n "$BATCH" ] && work_file audio/a1_48k.wav
      marker inspected ;;
    2)
      bash_tool s2 "python3 CLAUDE_VE_ALL/transcribe.py A-roll.wav" "Transcribe the A-roll with Whisper" "transcribed 92 s"
      tool r2 Read '{"file_path":"'"$VE"'/transcript.json"}' "48 lines"
      [ -n "$BATCH" ] && work_file transcripts/a1.full.json
      marker transcribed ;;
    3)
      mkdir -p "$VE"
      tool w3 Write '{"file_path":"'"$VE"'/edit_plan.md","content":"plan"}' "File created"
      [ -n "$BATCH" ] && work_file timeline.py
      say "The edit plan is written: 41 shots, 23 graphics."
      marker planned ;;
    4)
      out '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794637200,"unifiedWindows":{"five_hour":{"utilization":0.2,"resetsAt":1794637200}}},"session_id":"'"$SID"'"}'
      agent a4 "Build graphics group A"
      bash_tool t1 "ffmpeg -i in.mp4 out.mp4" "Render graphics at 1080" "rendered"
      [ -n "$BATCH" ] && { work_file gfx_src/hook/index.html; work_file gfx/1080/hook.mov; }
      marker graphics_built ;;
    5)
      bash_tool s5 "ffmpeg -i Broll/pour.mov -vf fps=25 CLAUDE_VE/broll/pour.mov" "Conform the b-roll clips" "conformed 8 clips"
      marker broll_ready ;;
    6)
      bash_tool s6 "ffmpeg -i mix.wav -af loudnorm=I=-14 voice.wav" "Assemble the timeline and normalize loudness" "-14.0 LUFS"
      [ -n "$BATCH" ] && work_file build/mix.mov
      marker assembled ;;
    7)
      bash_tool s7 "python3 CLAUDE_VE_ALL/qa_transcribe.py build/mix.wav" "QA re-transcription of the mix" "every line intact"
      [ -n "$BATCH" ] && work_file build/720/qa_sheet_1.jpg
      marker checked ;;
    8)
      write_review
      bash_tool s8 "python3 CLAUDE_VE_ALL/ve.py fcp" "Export the review project" "wrote the review project"
      marker review_saved ;;
    9)
      # A small valid PNG (64x36, one colour), so screenshots show no broken images.
      printf '\211\120\116\107\015\012\032\012\000\000\000\015\111\110\104\122\000\000\000\100\000\000\000\044\010\002\000\000\000\266\156\253\305\000\000\000\073\111\104\101\124\170\332\355\317\101\011\000\000\010\004\260\353\145\003\253\330\377\157\006\237\302\140\005\226\352\171\055\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\002\067\013\000\357\160\171\134\171\352\317\000\000\000\000\111\105\116\104\256\102\140\202' > "$VDIR/output/thumbnail-1.png"
      printf 'Titles:\n1. %s\n\nDescription:\nA test edit.\n\nTags: test\n' "$MAIN" > "$VDIR/output/meta.txt"
      tool w9 Write '{"file_path":"'"$VDIR"'/info.txt","content":"times"}' "File created"
      marker extras_written ;;
  esac
}

re_edit_step() {
  case "$1" in
    1)
      bash_tool e1 "python3 CLAUDE_VE_ALL/ve.py plan" "Apply the requested changes" "re-planned"
      marker changes_applied ;;
    2)
      write_review
      bash_tool e2 "python3 CLAUDE_VE_ALL/ve.py fcp" "Export the new review version" "exported"
      marker review_saved ;;
  esac
}

render_step() {
  case "$1" in
    1)
      bash_tool f1 "python3 CLAUDE_VE_ALL/ve.py gfx --res 2160" "Render the graphics at 4K" "rendered"
      marker render_started ;;
    2)
      write_review
      bash_tool f2 "ffmpeg -c:v hevc_videotoolbox final.mp4" "Encode the final render" "encoded"
      marker rendered ;;
  esac
}

complete() {
  init
  out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret thoughts","signature":"x"}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
  mkdir -p "$VDIR/output"
  case "$MESSAGE" in
    *"RE-EDIT REQUEST"*) steps=2; step=re_edit_step ;;
    *"Create the final output render"*) steps=2; step=render_step ;;
    *) steps=9; step=edit_step ;;
  esac
  i=1
  if [ -n "$RESUMES_STEPS" ] && [ -f "$ST/step.$MAIN" ]; then
    i=$(( $(cat "$ST/step.$MAIN") + 1 ))
  fi
  [ "$i" = 1 ] && maybe_stop 0
  while [ "$i" -le "$steps" ]; do
    "$step" "$i"
    [ -n "$RESUMES_STEPS" ] && echo "$i" > "$ST/step.$MAIN"
    pace "$i"
    maybe_stop "$i"
    i=$((i + 1))
  done
  rm -f "$ST/step.$MAIN"
  flush_markers
  say "[OUTPUT COMPLETED]"
  result "[OUTPUT COMPLETED]" 2 0.25
  wait_eof
  exit 0
}

case "$SCENARIO" in
  complete | render | progress | premature | batched)
    if [ "$MODE" = resume ] && [ -n "$RESUMES_STEPS" ]; then
      # Like the real Claude Code after --resume: an empty result first.
      out '{"type":"result","subtype":"success","is_error":false,"num_turns":0,"session_id":"'"$SID"'","total_cost_usd":0}'
      sleep 0.2
    fi
    complete
    ;;

  background)
    init
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"render.sh","description":"Render final","run_in_background":true}}]},"parent_tool_use_id":null}'
    out '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bg1","task_type":"local_bash","description":"Render final"}]}'
    out '{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"t1","description":"Render final","is_backgrounded":true,"task_type":"local_bash"}'
    out '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"Command running in background with ID: bg1."}]},"parent_tool_use_id":null}'
    result "Waiting for the render." 1 0.10
    # The task runs until the test releases it; the job must not finish in the meantime.
    while [ ! -e "$ST/release.background" ]; do
      if is_eof; then : > "$ST/closed_early"; exit 0; fi
      nap
    done
    out '{"type":"system","subtype":"task_updated","task_id":"bg1","patch":{"status":"completed"}}'
    out '{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"t1","status":"completed","summary":"Background command \"Render final\" completed (exit code 0)"}'
    out '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'
    sleep 0.05
    init
    write_review
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"[OUTPUT COMPLETED]"}]},"parent_tool_use_id":null}'
    result "[OUTPUT COMPLETED]" 2 0.30
    wait_eof
    exit 0
    ;;

  slow)
    if [ "$MODE" = resume ]; then
      # Like the real Claude Code after --resume: an empty result first.
      out '{"type":"result","subtype":"success","is_error":false,"num_turns":0,"session_id":"'"$SID"'","total_cost_usd":0.1}'
      sleep 0.3
      complete
    fi
    init
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"sleep 600","description":"Long step"}}]},"parent_tool_use_id":null}'
    while ! interrupted; do
      is_eof && exit 0
      nap
    done
    RID=$(grep -m 1 '"control_request"' "$IN" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
    out '{"type":"control_response","response":{"subtype":"success","request_id":"'"$RID"'","response":{"still_queued":[]}}}'
    out '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null}'
    out '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"terminal_reason":"aborted_streaming","errors":["[ede_diagnostic] result_type=user"],"total_cost_usd":0.1}'
    wait_eof
    exit 1
    ;;

  no_output)
    if [ "$MODE" = resume ]; then complete; fi
    while :; do
      init
      out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I could not finish."}]},"parent_tool_use_id":null}'
      result "I could not finish." 1 0.05
      next_message || exit 0
    done
    ;;

  spin)
    t=0
    while :; do
      t=$((t + 1))
      init
      bash_tool "spin$t" "ls" "List the folder again" "CLAUDE_VE"
      say "Still checking the folder."
      result "Still checking the folder." 1 0.05
      next_message || exit 0
    done
    ;;

  model_error)
    HAD=0
    [ -f "$ST/model_error_count.$MAIN" ] && HAD=$(cat "$ST/model_error_count.$MAIN")
    WANT=2
    [ -f "$ST/model_errors" ] && WANT=$(cat "$ST/model_errors")
    if [ "$HAD" -lt "$WANT" ]; then
      echo $((HAD + 1)) > "$ST/model_error_count.$MAIN"
      init
      ERR='API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}'
      say "$ERR"
      out '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"'"$ERR"'","api_error_status":529,"session_id":"'"$SID"'","total_cost_usd":0.01}'
      wait_eof
      exit 0
    fi
    complete
    ;;

  api_error)
    init
    edit_step 1
    edit_step 2
    edit_step 3
    ERR='API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"GoUsageLimitError\",\"message\":\"Go usage limit exceeded\"},\"metadata\":{\"limitName\":\"weekly\"}}'
    say "$ERR"
    if [ -e "$ST/api_error_quiet" ]; then
      out '{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"'"$ERR"'","session_id":"'"$SID"'","total_cost_usd":0.2}'
    else
      out '{"type":"result","subtype":"success","is_error":true,"num_turns":4,"result":"'"$ERR"'","api_error_status":429,"session_id":"'"$SID"'","total_cost_usd":0.2}'
    fi
    next_message || exit 0
    : > "$ST/continued_after_error"
    wait_eof
    exit 0
    ;;

  usage_limit)
    init
    RESET=$(( $(date +%s) + 7200 ))
    out '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":'"$RESET"',"rateLimitType":"five_hour"}}'
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"You have hit your limit"}]},"parent_tool_use_id":null}'
    out '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"You have hit your limit, resets 4pm","total_cost_usd":0}'
    wait_eof
    exit 1
    ;;

  quiet_limit)
    # A usage limit seen only on the event stream: no result, the process just ends.
    init
    RESET=$(( $(date +%s) + 7200 ))
    out '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":'"$RESET"',"rateLimitType":"five_hour"}}'
    exit 0
    ;;

  resume_missing)
    if [ "$MODE" = resume ]; then
      out '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"'"$SID"'","total_cost_usd":0,"errors":["No conversation found with session ID: '"$SID"'"]}'
      echo "No conversation found with session ID: $SID" >&2
      exit 1
    fi
    complete
    ;;

  tree)
    init
    # A child in its own process group (like Claude's Bash tool) and one that ignores SIGTERM.
    set -m
    sleep 300 &
    echo $! >> "$ST/tree.pids"
    sh -c 'trap "" TERM; while [ -d "$1" ]; do sleep 1; done' tree "$ST" &
    echo $! >> "$ST/tree.pids"
    set +m
    echo "$ME" >> "$ST/tree.pids"
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ffmpeg -i big.mov","description":"Encode"}}]},"parent_tool_use_id":null}'
    : > "$ST/tree.ready"
    # Answers interrupts but does not end when stdin closes: only ending the tree stops it (or
    # the end of the test).
    answered=0
    while [ -d "$ST" ]; do
      if [ "$answered" = 0 ] && interrupted; then
        RID=$(grep -m 1 '"control_request"' "$IN" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
        out '{"type":"control_response","response":{"subtype":"success","request_id":"'"$RID"'","response":{}}}'
        answered=1
      fi
      nap
    done
    exit 0
    ;;

  crash)
    init
    echo "Error: boom" >&2
    exit 2
    ;;

  echo_key)
    init
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo '"${ANTHROPIC_API_KEY-}"'","description":"Check the key '"${ANTHROPIC_API_KEY-}"'"}}]},"parent_tool_use_id":null}'
    out '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"token '"${ANTHROPIC_API_KEY-}"'"}]},"parent_tool_use_id":null}'
    write_review
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Used '"${ANTHROPIC_API_KEY-}"'. [OUTPUT COMPLETED]"}]},"parent_tool_use_id":null}'
    result "done" 1 0.01
    wait_eof
    exit 0
    ;;

  hold)
    init
    : > "$ST/started.$MAIN"
    while [ ! -e "$ST/release.$MAIN" ]; do
      if interrupted; then answer_interrupt; exit 0; fi
      is_eof && exit 0
      nap
    done
    complete
    ;;

  live)
    # Shows some work, then waits until the test drops FAKE_STATE/release.<video folder> (used
    # up, so a continued session waits again) and completes; a pause interrupts it.
    if [ "$MODE" = resume ]; then
      out '{"type":"result","subtype":"success","is_error":false,"num_turns":0,"session_id":"'"$SID"'","total_cost_usd":0}'
      sleep 0.2
    fi
    init
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Looking at the A-roll of '"$MAIN"'."}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"**Plan**\n\n1. Read the `timeline.py` notes\n2. Transcribe the *A-roll*"}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t0","name":"Read","input":{"file_path":"'"$VDIR"'/CLAUDE_VE/timeline.py"}}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
    out '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t0","type":"tool_result","content":"12 lines","is_error":false}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"python3 transcribe.py","description":"Transcribe the A-roll"}}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
    : > "$ST/started.$MAIN"
    while [ ! -e "$ST/release.$MAIN" ]; do
      if interrupted; then answer_interrupt; exit 0; fi
      is_eof && exit 0
      nap
    done
    rm -f "$ST/release.$MAIN"
    out '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"transcribed","is_error":false}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
    write_review
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"[OUTPUT COMPLETED]"}]},"parent_tool_use_id":null,"session_id":"'"$SID"'"}'
    result "[OUTPUT COMPLETED]" 2 0.42
    wait_eof
    exit 0
    ;;

  logged_out)
    # What Claude Code prints when its login is gone.
    init
    out '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Invalid API key \u00b7 Please run /login"}]},"parent_tool_use_id":null}'
    out '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"Invalid API key \u00b7 Please run /login","total_cost_usd":0}'
    wait_eof
    exit 1
    ;;

  *)
    echo "unknown scenario $SCENARIO" >&2
    exit 9
    ;;
esac

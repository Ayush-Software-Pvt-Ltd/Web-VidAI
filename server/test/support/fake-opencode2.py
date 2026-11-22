#!/usr/bin/env -S python3 -I
"""A fake OpenCode 2 program for the tests of the OpenCode driver (server/test/opencode/).

The call record also
lists the files of OPENCODE_CONFIG_DIR and says HOME (config_dir_files=, HOME=), and FAKE_OPENCODE_HANG
makes the requests whose path contains one of its comma separated words never answer.

It speaks the part of OpenCode 2 that VidAI drives (`server/src/agents/opencode/server*.js`), closely
enough for the job engine, with the event shapes recorded from the real OpenCode 2.2.6 in
server/test/support/fixtures/opencode2-stream/:

- `opencode2 --version` prints "opencode v" and FAKE_OPENCODE2_VERSION (default 2.2.6).
- `opencode2 serve --stdio --hostname 127.0.0.1 --port 0` listens on a free port, prints
  {"url":"http://127.0.0.1:<port>"} and ends when its stdin closes (without --stdio it prints
  "server listening on http://..."). Every request needs HTTP basic auth (user `opencode`, the
  password of OPENCODE_PASSWORD or else OPENCODE_SERVER_PASSWORD; anything else is answered 401).
  GET /api/event (server-sent events: server.connected, then every event, a heartbeat comment
  every 10 seconds), GET /api/model, GET /api/integration/<id>, POST /api/session,
  GET /api/session/<id> (404 SessionNotFoundError for an unknown one), POST
  /api/session/<id>/model, POST /api/session/<id>/prompt, POST /api/session/<id>/interrupt,
  GET /api/experimental/job, DELETE /api/shell/<id>, POST
  /api/session/<id>/permission/<id>/reply, DELETE /api/session/<id>/form/<id>?message=...

A message is queued for its session; a session that is not busy starts a busy period
(session.execution.started), delivers what is queued and does the work of the scenario, then ends
it with exactly one terminal event. A background command or sub-agent reports back with a
synthetic message that wakes the session again, as in OpenCode 2.

Sessions are kept in FAKE_STATE/opencode2-sessions/<id>.json, so a later server resumes them.
FAKE_STATE is a folder where every server records its arguments, working directory and the
variables VidAI sets (call.<pid>, with program=opencode2; its pid is appended to
FAKE_STATE/opencode2.calls), every message it gets (prompts.<session>, with the session's model
and the folder of the request), interrupts (interrupt.<session>), ended commands
(deleted.<shell>), answers (permission.<id>, form.<id>), and where tests leave signals
(release.<video folder>).

The scenario is FAKE_SCENARIO; without it the content of FAKE_STATE/scenario.<video folder> or
FAKE_STATE/scenario, else "complete". Scenarios:

- complete: the steps of a real job of the requested kind (edit, re-edit or render) with
  OpenCode 2's tools (shell, read, write, subagent), the progress markers and the review project
  (or the final render), then "[OUTPUT COMPLETED]". An edit builds its graphics with a sub-agent in
  the background: the first busy period ends while it works, its report wakes the session, and the
  next busy period finishes the edit.
- early_end: the first busy period only announces a step and ends; the next message completes.
- hold: a shell command runs until the test drops FAKE_STATE/release.<video folder> (used up),
  then the job completes; an interrupt cuts it (its failed result holds the progress lines it had
  printed). The server writes FAKE_STATE/started.<video>.
- tree: like hold, and the command has children in process groups of their own, one of which
  ignores SIGTERM (their pids in FAKE_STATE/tree.pids).
- background_hold: a command in the background (a `sleep` in a process group of its own, its pid
  in FAKE_STATE/tree.pids) and a sub-agent that both run until released; the busy period ends
  while they run (FAKE_STATE/started.<video> then). Continue completes the edit.
- api_error: the gateway refuses the key (401).
- usage_limit: the Go plan's weekly limit is reached (the busy period fails with it).
- usage_limit_retry: OpenCode 2 waits before a retry for a Go limit and goes on waiting.
- permission: asks for a permission and completes once it is answered.
- question: shows a question form and completes once it is cancelled.
- echo_key: a tool prints the key (VIDAI_API_KEY when set, else OPENCODE_API_KEY), then the job completes.
- no_output: the model says it is done without saving anything.
- crash: the server ends with an error when the message arrives.

FAKE_OPENCODE_HANG makes a request whose path contains one of its comma separated words (`prompt`,
`session`) never answer (the connection stays open), to test the request time limit.
FAKE_OPENCODE2_LOGIN=stored makes OpenCode's own providers use a login stored in OpenCode (not
OPENCODE_API_KEY). FAKE_OPENCODE_MODELS lists the models of OpenCode's own providers.
A server whose FAKE_STATE folder is gone ends by itself, so it never outlives its test.
"""

import base64
import json
import os
import random
import re
import signal
import string
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

if len(sys.argv) > 1 and sys.argv[1] in ("--version", "-v"):
    print("opencode v" + os.environ.get("FAKE_OPENCODE2_VERSION", "2.2.6"))
    sys.exit(0)

if len(sys.argv) < 2 or sys.argv[1] != "serve":
    print("fake opencode2: only serve and --version", file=sys.stderr)
    sys.exit(2)

ST = os.environ.get("FAKE_STATE", "")
if not ST or not os.path.isdir(ST):
    print("fake opencode2: FAKE_STATE is not a folder", file=sys.stderr)
    sys.exit(2)
SESSIONS = os.path.join(ST, "opencode2-sessions")
os.makedirs(SESSIONS, exist_ok=True)
ME = os.getpid()
PASSWORD = os.environ.get("OPENCODE_PASSWORD") or os.environ.get("OPENCODE_SERVER_PASSWORD", "")
STDIO = "--stdio" in sys.argv
VERSION = os.environ.get("FAKE_OPENCODE2_VERSION", "2.2.6")


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


HOST = arg("--hostname", "127.0.0.1")
PORT = int(arg("--port", "4096"))


def record_call():
    with open(os.path.join(ST, f"call.{ME}"), "w") as f:
        f.write("program=opencode2\n")
        f.write("args=" + " ".join(sys.argv[1:]) + "\n")
        f.write("cwd=" + os.getcwd() + "\n")
        for var in ("OPENCODE_API_KEY", "VIDAI_API_KEY", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_AUTOUPDATE",
                    "OPENCODE_PASSWORD", "OPENCODE_SERVER_USERNAME", "OPENCODE_FLAGS",
                    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                    "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_PROJECT_DISABLE", "OPENCODE_CONFIG"):
            f.write(f"{var}={os.environ.get(var, '<unset>')}\n")
        f.write("HOME=" + os.environ.get("HOME", "<unset>") + "\n")
        config_dir = os.environ.get("OPENCODE_CONFIG_DIR")
        listing = sorted(os.listdir(config_dir)) if config_dir and os.path.isdir(config_dir) else None
        f.write("config_dir_files=" + ("<none>" if listing is None else ",".join(listing)) + "\n")
        f.write("OPENCODE_SERVER_PASSWORD=" + ("<set>" if os.environ.get("OPENCODE_SERVER_PASSWORD") else "<unset>") + "\n")
    with open(os.path.join(ST, "opencode2.calls"), "a") as f:
        f.write(f"{ME}\n")


def note(name, text=""):
    with open(os.path.join(ST, name), "a") as f:
        f.write(text + "\n")


# ----- the event bus -----

subscribers = []
bus_lock = threading.Lock()
counter = [0]
id_lock = threading.Lock()


def ident(prefix):
    with id_lock:
        counter[0] += 1
        n = counter[0]
    tail = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(12))
    return f"{prefix}_{int(time.time() * 1000):x}{n:04d}{tail}"


def ms():
    return int(time.time() * 1000)


def emit(kind, data, directory=None):
    event = {"id": ident("evt"), "created": ms(), "type": kind, "data": data}
    if directory:
        event["location"] = {"directory": directory}
    text = json.dumps(event)
    with bus_lock:
        for queue in list(subscribers):
            queue.append(text)
            queue.ready.set()


class Queue(list):
    def __init__(self):
        super().__init__()
        self.ready = threading.Event()


# ----- sessions -----

def session_path(sid):
    return os.path.join(SESSIONS, re.sub(r"[^A-Za-z0-9_]", "", sid) + ".json")


def load(sid):
    try:
        with open(session_path(sid)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save(session):
    tmp = session_path(session["id"]) + f".{ME}.tmp"
    with open(tmp, "w") as f:
        json.dump(session, f)
    os.replace(tmp, session_path(session["id"]))


def info(session):
    return {"id": session["id"], "projectID": "prj", "model": session.get("model"),
            "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
            "time": {"created": session.get("created", ms()), "updated": ms()},
            "title": session.get("title"), "permissions": session.get("permissions"),
            "location": {"directory": session["directory"]},
            **({"parentID": session["parentID"]} if session.get("parentID") else {})}


lock = threading.RLock()
inboxes = {}   # session id -> queued items
busy = {}      # session id -> the running Execution
jobs = {}      # job id -> job (background shells and sub-agents)


def enqueue(sid, item):
    inbox_id = ident("msg")
    session = load(sid)
    emit("session.inbox.enqueued", {"inboxID": inbox_id, "sessionID": sid, "item": item},
         session["directory"] if session else None)
    with lock:
        inboxes.setdefault(sid, []).append((inbox_id, item))
        running = sid in busy
        if not running:
            busy[sid] = None
    if not running:
        threading.Thread(target=drain, args=(sid,), daemon=True).start()
    return inbox_id


def drain(sid):
    """Busy periods of one session while messages are queued."""
    while True:
        with lock:
            items = inboxes.pop(sid, [])
            if not items:
                busy.pop(sid, None)
                return
            ex = Execution(load(sid))
            busy[sid] = ex
        emit("session.execution.started", {"sessionID": sid})
        for inbox_id, _ in items:
            emit("session.inbox.delivered", {"sessionID": sid, "inboxID": inbox_id}, ex.directory)
        try:
            work(ex, [item for _, item in items])
            ex.succeeded()
        except Aborted:
            ex.interrupted()
        except Failed as failure:
            ex.failed(failure.error)
        ended = getattr(ex, "on_end", None)
        if ended is not None:
            # A sub-agent started in this busy period begins once it has ended.
            ended.set()


class Aborted(Exception):
    pass


class Failed(Exception):
    def __init__(self, error):
        super().__init__(error.get("message"))
        self.error = error


class Execution:
    """One busy period of a session, with the low-level shapes of OpenCode 2.2.6."""

    def __init__(self, session):
        self.session = session
        self.sid = session["id"]
        self.directory = session["directory"]
        self.abort = threading.Event()
        self.model = session.get("model") or {"providerID": "opencode", "id": "big-pickle"}

    def ev(self, kind, **data):
        emit(kind, dict({"sessionID": self.sid}, **data), self.directory)

    def check(self):
        if self.abort.is_set():
            raise Aborted()

    def step(self):
        self.check()
        mid = ident("msg")
        self.ev("session.step.started", agent="build", model=dict(self.model, variant="default"),
                assistantMessageID=mid, started=ms())
        return mid

    def end_step(self, mid, finish):
        self.ev("session.step.streamed", assistantMessageID=mid)
        tokens = {"input": 1000, "output": 200, "reasoning": 0, "cache": {"read": 0, "write": 0}}
        self.ev("session.step.ended", assistantMessageID=mid, finish=finish, rawFinish=finish,
                tokens=tokens, cost=0.01)
        self.ev("session.usage.updated", cost=0.01, tokens=tokens)

    def say(self, text):
        mid = self.step()
        self.ev("session.text.started", assistantMessageID=mid, ordinal=0)
        self.ev("session.text.delta", assistantMessageID=mid, ordinal=0, delta=text)
        self.ev("session.text.ended", assistantMessageID=mid, ordinal=0, text=text)
        self.end_step(mid, "stop")

    def tool(self, name, tool_input, output, metadata=None, run=None):
        """One step with one tool call. `run(call, mid)` runs while the tool runs and returns its
        result metadata, or raises Aborted after reporting the tool's failure."""
        mid = self.step()
        call = ident("call")
        self.ev("session.tool.input.started", assistantMessageID=mid, id=call, name=name)
        self.ev("session.tool.input.ended", assistantMessageID=mid, id=call, text=json.dumps(tool_input))
        self.ev("session.tool.called", assistantMessageID=mid, id=call, input=tool_input, executed=False)
        if run is not None:
            try:
                metadata = run(call, mid) or metadata
            except Aborted:
                partial = getattr(self, "partial", None)
                self.ev("session.tool.failed", assistantMessageID=mid, id=call,
                        error={"type": "aborted", "message": "Tool execution interrupted"},
                        content=[{"type": "text", "text": partial}] if partial else [],
                        metadata=metadata or {}, executed=False)
                self.ev("session.step.failed", assistantMessageID=mid,
                        error={"type": "aborted", "message": "Step interrupted"}, rawFinish="tool_calls", cost=0)
                raise
        content = output if isinstance(output, list) else [{"type": "text", "text": output}]
        self.ev("session.tool.success", assistantMessageID=mid, id=call, content=content,
                metadata=metadata or {"truncated": False}, executed=False)
        self.end_step(mid, "tool-calls")
        return call

    def shell(self, command, output, run=None, timeout=None):
        tool_input = {"command": command}
        if timeout:
            tool_input["timeout"] = timeout
        shell_id = ident("sh")

        def running(call, mid):
            emit("shell.created", {"info": {"id": shell_id, "status": "running", "command": command,
                                             "cwd": self.directory, "shell": "/bin/zsh",
                                             "metadata": {"sessionID": self.sid}}}, self.directory)
            self.ev("session.tool.progress", assistantMessageID=mid, id=call, metadata={"shellID": shell_id})
            if run is not None:
                try:
                    run()
                except Aborted:
                    emit("shell.exited", {"id": shell_id, "status": "killed"}, self.directory)
                    raise
            emit("shell.exited", {"id": shell_id, "exit": 0, "status": "exited"}, self.directory)
            return {"status": "completed", "truncated": False, "exit": 0}

        return self.tool("shell", tool_input, output, run=running)

    def wait(self, check):
        """Waits until `check()` is true, or raises Aborted."""
        while not self.abort.is_set():
            if check():
                return
            if not os.path.isdir(ST):
                os._exit(0)
            self.abort.wait(0.1)
        raise Aborted()

    def succeeded(self):
        self.ev("session.execution.succeeded")

    def interrupted(self):
        self.ev("session.execution.interrupted", reason="user")

    def failed(self, error):
        self.ev("session.execution.failed", error=error)


# ----- background work -----

def report(job, state, body):
    """A background job's report, queued for the session that started it (wakes it)."""
    job["status"] = {"completed": "completed", "cancelled": "cancelled"}.get(state, "error")
    if job["kind"] == "shell":
        text = f'<shell id="{job["id"]}" state="{state}" command="{job["command"]}">\n{body}\n</shell>'
        metadata = {"source": "shell", "shellID": job["id"], "jobID": job["id"], "state": state}
        description = job["command"]
    else:
        text = (f'<subagent sessionID="{job["childSessionID"]}" state="{state}" '
                f'description="{job["description"]}">\n{body}\n</subagent>')
        metadata = {"source": "subagent", "childID": job["childSessionID"], "agent": "General", "state": state}
        description = job["description"]
    enqueue(job["sessionID"], {"type": "synthetic", "payload": {
        "text": text, "description": description, "metadata": metadata}, "delivery": "steer"})


def background_shell(ex, command, run):
    """A shell call with `background: true`: it answers at once and `run()` goes on."""
    shell_id = ident("sh")
    job = {"kind": "shell", "id": shell_id, "sessionID": ex.sid, "status": "running", "title": command,
           "time": {"started": ms()}, "shellID": shell_id, "command": command}
    with lock:
        jobs[shell_id] = job

    def start(call, mid):
        emit("shell.created", {"info": {"id": shell_id, "status": "running", "command": command,
                                         "cwd": ex.directory, "metadata": {"sessionID": ex.sid}}}, ex.directory)
        ex.ev("session.tool.progress", assistantMessageID=mid, id=call, metadata={"shellID": shell_id})

        def body():
            output = run(job)
            if job["status"] == "running":
                emit("shell.exited", {"id": shell_id, "exit": 0, "status": "exited"}, ex.directory)
                report(job, "completed", output)

        threading.Thread(target=body, daemon=True).start()
        return {"status": "running", "truncated": False, "shellID": shell_id}

    ex.tool("shell", {"command": command, "background": True},
            [{"type": "text", "text": f"Command moved to the background (shell ID: {shell_id})."},
             {"type": "text", "text": "You will be notified automatically when the command finishes."}],
            run=start)
    return job


def subagent(ex, description, child_work, after=None):
    """A subagent call: a child session works in the background and reports to `ex`'s session.
    `child_work(child)` runs as the child's busy period; `after` (an Event) delays it."""
    child_id = ident("ses")
    child = {"id": child_id, "parentID": ex.sid, "title": description, "directory": ex.directory,
             "model": ex.model, "created": ms(), "main": ex.session.get("main")}
    save(child)
    job = {"kind": "subagent", "id": child_id, "sessionID": ex.sid, "status": "running", "title": description,
           "time": {"started": ms()}, "childSessionID": child_id, "agent": "general", "description": description}
    with lock:
        jobs[child_id] = job

    def start(call, mid):
        emit("session.created", {"sessionID": child_id, "slug": "calm-lagoon", "version": VERSION,
                                 "projectID": "prj", "parentID": ex.sid, "location": {"directory": ex.directory},
                                 "title": description, "model": ex.model}, ex.directory)
        ex.ev("session.tool.progress", assistantMessageID=mid, id=call,
              metadata={"sessionID": child_id, "status": "running"})

        def body():
            if after is not None:
                after.wait(30)
            child_ex = Execution(load(child_id))
            with lock:
                busy[child_id] = child_ex
            emit("session.inbox.enqueued", {"inboxID": ident("msg"), "sessionID": child_id, "item": {
                "type": "user", "payload": {"text": "You are a subagent spawned by another session.\nBuild it."},
                "delivery": "steer"}}, ex.directory)
            emit("session.execution.started", {"sessionID": child_id})
            try:
                answer = child_work(child_ex)
                child_ex.succeeded()
                state = "completed"
            except Aborted:
                child_ex.interrupted()
                answer, state = "Subagent cancelled", "cancelled"
            with lock:
                busy.pop(child_id, None)
            if job["status"] == "running":
                report(job, state, answer)

        threading.Thread(target=body, daemon=True).start()
        return {"sessionID": child_id, "status": "running", "truncated": False}

    ex.tool("subagent", {"agent": "general", "description": description, "prompt": "Build it."},
            f"The subagent is working in the background (sessionID: {child_id}).", run=start)
    return job


# ----- the work of a job -----

def video_dir(session):
    return os.path.join(session["directory"], session.get("channel", ""), session.get("main", ""))


def write_review(session, render=False):
    out = os.path.join(video_dir(session), "output")
    os.makedirs(out, exist_ok=True)
    main = session.get("main", "video")
    if render:
        open(os.path.join(out, f"{main}_final.mp4"), "wb").close()
        return
    if session.get("software") == "Premiere Pro":
        n = len([f for f in os.listdir(out) if f.endswith(".xml")]) + 1
        with open(os.path.join(out, f"{main}_v{n}.xml"), "w") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n'
                    f"<xmeml version=\"4\"><sequence><name>{main}</name></sequence></xmeml>\n")
    else:
        n = len([f for f in os.listdir(out) if f.endswith(".fcpxml")]) + 1
        with open(os.path.join(out, f"{main}_v{n}.fcpxml"), "w") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n'
                    '<fcpxml version="1.11"><resources/><library/></fcpxml>\n')


def write_extras(session):
    out = os.path.join(video_dir(session), "output")
    os.makedirs(out, exist_ok=True)
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAAO0lEQVR42u3PQQkAAAgEsOtlA6vY/28Gn8JgBZbqeS0C"
        "AgICAgICAgICAgICAgICAgICAgICAgICAjcLAO9weVx56s8AAAAASUVORK5CYII=")
    with open(os.path.join(out, "thumbnail-1.png"), "wb") as f:
        f.write(png)
    with open(os.path.join(out, "meta.txt"), "w") as f:
        f.write(f"Titles:\n1. {session.get('main', '')}\n\nDescription:\nA test edit.\n\nTags: test\n")


def marker(ex, name):
    if not os.path.exists(os.path.join(ST, "no_markers")):
        ex.say(f"[VIDAI_PROGRESS {name}]")


def set_phase(ex, phase):
    session = load(ex.sid)
    session["phase"] = phase
    save(session)
    ex.session = session


def first_half(ex):
    s = ex.session
    ve = os.path.join(video_dir(s), "CLAUDE_VE")
    ex.tool("read", {"path": os.path.join(s["directory"], "MEMORY.md")}, "Read file MEMORY.md, lines 1-120")
    ex.shell("ffprobe -v error -show_streams A-roll.mov", "1080x1920, 25 fps, 92 s")
    marker(ex, "inspected")
    ex.shell("python3 CLAUDE_VE_ALL/transcribe.py A-roll.wav", "transcribed 92 s", timeout=3600000)
    ex.tool("read", {"path": os.path.join(ve, "transcript.json")}, "Read file transcript.json, lines 1-48")
    marker(ex, "transcribed")
    os.makedirs(ve, exist_ok=True)
    ex.tool("write", {"path": os.path.join(ve, "edit_plan.md"), "content": "plan"}, "Created file successfully: edit_plan.md")
    ex.say("The edit plan is written: 41 shots, 23 graphics.")
    marker(ex, "planned")


def second_half(ex):
    s = ex.session
    marker(ex, "graphics_built")
    ex.shell("ffmpeg -i Broll/pour.mov -vf fps=25 CLAUDE_VE/broll/pour.mov", "conformed 8 clips")
    marker(ex, "broll_ready")
    ex.shell("ffmpeg -i mix.wav -af loudnorm=I=-14 voice.wav", "-14.0 LUFS")
    marker(ex, "assembled")
    ex.shell("python3 CLAUDE_VE_ALL/qa_transcribe.py build/mix.wav", "every line intact")
    marker(ex, "checked")
    write_review(s)
    ex.shell("python3 CLAUDE_VE_ALL/ve.py fcp", "wrote the review project")
    marker(ex, "review_saved")
    write_extras(s)
    ex.tool("write", {"path": os.path.join(video_dir(s), "info.txt"), "content": "times"}, "Created file successfully: info.txt")
    marker(ex, "extras_written")
    ex.say("[OUTPUT COMPLETED]")


def graphics_child(child):
    child.shell("npx hyperframes render", "rendered")
    child.say("Build graphics group A finished")
    return "Build graphics group A finished"


def complete(ex, text, background=True):
    s = ex.session
    if "RE-EDIT REQUEST" in text:
        ex.shell("python3 CLAUDE_VE_ALL/ve.py plan", "re-planned")
        marker(ex, "changes_applied")
        write_review(s)
        ex.shell("python3 CLAUDE_VE_ALL/ve.py fcp", "exported")
        marker(ex, "review_saved")
        ex.say("[OUTPUT COMPLETED]")
    elif "Create the final output render" in text:
        ex.shell("python3 CLAUDE_VE_ALL/ve.py gfx --res 2160", "rendered", timeout=3600000)
        marker(ex, "render_started")
        write_review(s, render=True)
        ex.shell("ffmpeg -c:v hevc_videotoolbox final.mp4", "encoded")
        marker(ex, "rendered")
        ex.say("[OUTPUT COMPLETED]")
    elif background:
        first_half(ex)
        # The graphics are built by a sub-agent in the background; this busy period ends and the
        # sub-agent's report starts the next one.
        set_phase(ex, "graphics")
        ended = threading.Event()
        ex.on_end = ended
        subagent(ex, "Build graphics group A", graphics_child, after=ended)
        ex.say("The graphics are being built in the background; I will go on when they are done.")
    else:
        first_half(ex)
        second_half(ex)


def release(ex):
    name = os.path.join(ST, "release." + ex.session.get("main", ""))
    if os.path.exists(name):
        try:
            os.remove(name)
        except OSError:
            pass
        return True
    return False


def hold(ex, text, tree=False):
    s = ex.session
    ex.say(f"Looking at the A-roll of {s.get('main', '')}.")
    children = []
    # What the command had printed when an interrupt cuts it (the failed tool result holds it).
    ex.partial = "[1/124]    8.19-  10.87 Hello there\n[2/124]   10.87-  12.40 and welcome"

    def run():
        if tree:
            # Like OpenCode 2's shell tool: commands in process groups of their own.
            children.append(subprocess.Popen(["sleep", "300"], start_new_session=True))
            children.append(subprocess.Popen(
                ["sh", "-c", 'trap "" TERM; while [ -d "$1" ]; do sleep 1; done', "tree", ST],
                start_new_session=True))
            with open(os.path.join(ST, "tree.pids"), "a") as f:
                for child in children:
                    f.write(f"{child.pid}\n")
                f.write(f"{ME}\n")
            open(os.path.join(ST, "tree.ready"), "w").close()
        open(os.path.join(ST, "started." + s.get("main", "")), "w").close()
        ex.wait(lambda: release(ex))

    ex.shell("python3 transcribe.py", "transcribed", run=run, timeout=3600000)
    complete(ex, text, background=False)


def background_hold(ex):
    s = ex.session
    ex.say(f"Rendering {s.get('main', '')} in the background.")
    proc = []

    def render(job):
        proc.append(subprocess.Popen(["sleep", "300"], start_new_session=True))
        job["process"] = proc[0]
        with open(os.path.join(ST, "tree.pids"), "a") as f:
            f.write(f"{proc[0].pid}\n")
        proc[0].wait()
        return "rendered"

    background_shell(ex, "python3 render_all.py", render)

    def child_work(child):
        child.shell("npx hyperframes render group-b", "rendered", run=lambda: child.wait(lambda: release(child)))
        child.say("Group B finished")
        return "Group B finished"

    subagent(ex, "Render group B", child_work)
    while not proc:
        time.sleep(0.02)
    ex.say("Both run in the background; I will go on when they report.")
    open(os.path.join(ST, "started." + s.get("main", "")), "w").close()


def scenario_of(session):
    if os.environ.get("FAKE_SCENARIO"):
        return os.environ["FAKE_SCENARIO"]
    names = ["scenario." + session["main"]] if session.get("main") else []
    for name in names + ["scenario"]:
        path = os.path.join(ST, name)
        if os.path.exists(path):
            with open(path) as f:
                return f.read().strip()
    return "complete"


def work(ex, items):
    """What a busy period of a main session does with what was delivered."""
    s = ex.session
    users = [i["payload"]["text"] for i in items if i["type"] == "user"]
    reports = [i for i in items if i["type"] == "synthetic"]
    if not users:
        # Woken by background reports.
        if s.get("phase") == "graphics" and any(
                r["payload"]["metadata"].get("source") == "subagent" for r in reports):
            set_phase(ex, None)
            second_half(ex)
        else:
            ex.say("Noted.")
        return
    text = users[-1]
    scenario = scenario_of(s)
    if scenario in ("complete", "render"):
        complete(ex, text)
    elif scenario == "early_end":
        if s.get("early_done"):
            complete(ex, text)
        else:
            s["early_done"] = True
            save(s)
            ex.say("Next I will transcribe the A-roll.")
    elif scenario == "hold":
        hold(ex, text)
    elif scenario == "tree":
        hold(ex, text, tree=True)
    elif scenario == "background_hold":
        if text.startswith("Continue the video edit"):
            complete(ex, text, background=False)
        else:
            background_hold(ex)
    elif scenario == "api_error":
        mid = ex.step()
        error = {"type": "provider.auth", "message": "Invalid credential", "status": 401,
                 "response": {"body": json.dumps({"type": "error", "error": {
                     "type": "authentication_error", "message": "Invalid credential"}})}}
        ex.ev("session.step.failed", assistantMessageID=mid, error=error)
        raise Failed(error)
    elif scenario == "usage_limit":
        mid = ex.step()
        error = {"type": "provider.go-limit", "status": 429,
                 "message": "OpenCode Go weekly usage limit reached. Switch to a free model, or turn on Extra Usage.",
                 "response": {"body": json.dumps({"type": "error", "error": {
                     "type": "GoUsageLimitError", "message": "Go usage limit exceeded"},
                     "metadata": {"limitName": "weekly"}})}}
        ex.ev("session.step.failed", assistantMessageID=mid, error=error)
        raise Failed(error)
    elif scenario == "usage_limit_retry":
        mid = ex.step()
        ex.ev("session.retry.scheduled", assistantMessageID=mid, attempt=1, at=ms() + 183600000, error={
            "type": "provider.go-limit", "status": 429, "message": "OpenCode Go weekly usage limit reached.",
            "response": {"body": json.dumps({"type": "error", "error": {
                "type": "GoUsageLimitError", "message": "Go usage limit exceeded"},
                "metadata": {"limitName": "weekly"}})}})
        ex.wait(lambda: False)
    elif scenario == "permission":
        pid = ident("per")
        emit("permission.asked", {"id": pid, "sessionID": ex.sid, "action": "read",
                                  "resources": ["/etc/hosts"], "save": ["*"]}, ex.directory)
        ex.wait(lambda: os.path.exists(os.path.join(ST, f"permission.{pid}")))
        complete(ex, text, background=False)
    elif scenario == "question":
        fid = ident("frm")
        mid = ex.step()
        call = ident("call")
        question = {"questions": [{"question": "Which look?", "header": "Look", "options": [{"label": "A"}]}]}
        ex.ev("session.tool.input.started", assistantMessageID=mid, id=call, name="question")
        ex.ev("session.tool.called", assistantMessageID=mid, id=call, input=question, executed=False)
        emit("form.created", {"form": {"id": fid, "sessionID": ex.sid, "title": "Questions",
                                       "metadata": {"kind": "question", "tool": {"messageID": mid, "id": call}},
                                       "fields": [{"key": "q0", "type": "string", "title": "Look"}]}}, ex.directory)
        ex.wait(lambda: os.path.exists(os.path.join(ST, f"form.{fid}")))
        with open(os.path.join(ST, f"form.{fid}")) as f:
            message = f.read().strip()
        emit("form.cancelled", {"id": fid, "sessionID": ex.sid}, ex.directory)
        ex.ev("session.tool.failed", assistantMessageID=mid, id=call,
              error={"type": "tool.execution", "message": message}, executed=False)
        ex.end_step(mid, "tool-calls")
        complete(ex, text, background=False)
    elif scenario == "echo_key":
        var = "VIDAI_API_KEY" if os.environ.get("VIDAI_API_KEY") else "OPENCODE_API_KEY"
        ex.shell("echo $" + var, "key is " + os.environ.get(var, ""))
        complete(ex, text, background=False)
    elif scenario == "no_output":
        ex.say("I could not finish.")
    elif scenario == "crash":
        print("Error: boom", file=sys.stderr, flush=True)
        os._exit(3)
    else:
        print(f"unknown scenario {scenario}", file=sys.stderr, flush=True)
        os._exit(9)


# ----- HTTP -----

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def authorized(self):
        expected = "Basic " + base64.b64encode(f"opencode:{PASSWORD}".encode()).decode()
        return bool(PASSWORD) and self.headers.get("Authorization") == expected

    def reply(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def directory(self):
        header = self.headers.get("x-opencode-directory")
        return unquote(header) if header else os.getcwd()

    def route(self):
        return urlparse(self.path).path

    def maybe_hang(self):
        words = [w for w in os.environ.get("FAKE_OPENCODE_HANG", "").split(",") if w]
        if any(w in self.path for w in words):
            time.sleep(3600)

    def query(self):
        return parse_qs(urlparse(self.path).query)

    def not_found(self, sid):
        self.reply(404, {"_tag": "SessionNotFoundError", "sessionID": sid, "message": f"Session not found: {sid}"})

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {"_tag": "UnauthorizedError", "message": "Authentication required"})
        self.maybe_hang()
        path = self.route()
        if path == "/api/event":
            return self.events()
        if path == "/api/info":
            return self.reply(200, {"version": VERSION, "pid": ME})
        if path == "/api/model":
            models = os.environ.get("FAKE_OPENCODE_MODELS", "glm-5.3,kimi-k3").split(",")
            levels = [v for v in os.environ.get("FAKE_OPENCODE_VARIANTS", "low,high").split(",") if v]
            variants = [{"id": v, "settings": {"reasoningEffort": v}} for v in levels]
            return self.reply(200, {"location": {"directory": self.directory()}, "data": [
                {"id": m, "modelID": m, "providerID": p, "name": m, "variants": variants}
                for p in ("opencode-go", "opencode", "vidai") for m in models if m]})
        m = re.fullmatch(r"/api/integration/([^/]+)", path)
        if m:
            connections = []
            if m.group(1) in ("opencode", "opencode-go"):
                if os.environ.get("FAKE_OPENCODE2_LOGIN") == "stored":
                    connections.append({"type": "credential", "id": "crd_1", "label": "OpenCode"})
                if os.environ.get("OPENCODE_API_KEY"):
                    connections.append({"type": "env", "name": "OPENCODE_API_KEY"})
            return self.reply(200, {"location": {"directory": self.directory()}, "data": {
                "id": m.group(1), "name": m.group(1), "methods": [], "connections": connections}})
        if path == "/api/experimental/job":
            q = self.query()
            root = q.get("sessionID", [""])[0]
            with lock:
                listed = [dict((k, v) for k, v in j.items() if k != "process") for j in jobs.values()]
            tree = {root} | {j["childSessionID"] for j in listed if j["kind"] == "subagent"}
            listed = [j for j in listed if j["sessionID"] in tree]
            if q.get("status"):
                listed = [j for j in listed if j["status"] == q["status"][0]]
            return self.reply(200, {"data": listed})
        m = re.fullmatch(r"/api/session/([^/]+)", path)
        if m:
            session = load(m.group(1))
            if session is None:
                return self.not_found(m.group(1))
            return self.reply(200, {"data": info(session)})
        self.reply(404, {"_tag": "NotFound", "message": path})

    def do_DELETE(self):
        if not self.authorized():
            return self.reply(401, {"_tag": "UnauthorizedError", "message": "Authentication required"})
        self.maybe_hang()
        path = self.route()
        m = re.fullmatch(r"/api/shell/([^/]+)", path)
        if m:
            with lock:
                job = jobs.get(m.group(1))
            note(f"deleted.{m.group(1)}", self.directory())
            if job is not None and job["status"] == "running":
                process = job.get("process")
                if process is not None:
                    process.kill()
                emit("shell.exited", {"id": job["id"], "status": "killed"}, self.directory())
                report(job, "cancelled", "Cancelled")
            return self.reply(204)
        m = re.fullmatch(r"/api/session/([^/]+)/form/([^/]+)", path)
        if m:
            message = self.query().get("message", [""])[0]
            with open(os.path.join(ST, f"form.{m.group(2)}"), "w") as f:
                f.write(message)
            return self.reply(204)
        self.reply(404, {"_tag": "NotFound", "message": path})

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {"_tag": "UnauthorizedError", "message": "Authentication required"})
        self.maybe_hang()
        path = self.route()
        body = self.body()
        if path == "/api/session":
            sid = ident("ses")
            directory = (body.get("location") or {}).get("directory") or os.getcwd()
            session = {"id": sid, "title": body.get("title"), "permissions": body.get("permissions"),
                       "model": body.get("model"), "directory": directory, "created": ms()}
            save(session)
            emit("session.created", {"sessionID": sid, "slug": "mighty-engine", "version": VERSION,
                                     "projectID": "prj", "location": {"directory": directory},
                                     "title": session["title"], "permissions": session["permissions"],
                                     "model": session["model"]}, directory)
            return self.reply(200, {"data": info(session)})
        m = re.fullmatch(r"/api/session/([^/]+)/(prompt|interrupt|model)", path)
        if m:
            sid, action = m.groups()
            session = load(sid)
            if session is None:
                return self.not_found(sid)
            if action == "interrupt":
                note(f"interrupt.{sid}")
                with lock:
                    ex = busy.get(sid)
                if ex is not None:
                    ex.abort.set()
                return self.reply(200, {"interrupted": ex is not None})
            if action == "model":
                session["model"] = body.get("model")
                save(session)
                note(f"model.{sid}", json.dumps(body.get("model")))
                return self.reply(200, {"data": info(session)})
            text = body.get("text", "")
            with open(os.path.join(ST, f"prompts.{sid}"), "a") as f:
                f.write(json.dumps({"model": session.get("model"), "text": text, "server": ME,
                                    "directory": self.directory()}) + "\n")
            for key, pattern in (("main", r"MAIN_FOLDER = ([^\n]*)"), ("channel", r"CHANNEL_FOLDER = ([^\n]*)"),
                                 ("software", r"REVIEW_OUTPUT_SOFTWARE = ([^\n]*)")):
                found = re.search(pattern, text)
                if found and key not in session:
                    session[key] = found.group(1).strip()
            save(session)
            if scenario_of(session) == "crash":
                print("Error: boom", file=sys.stderr, flush=True)
                os._exit(3)
            item = {"type": "user", "payload": {"text": text}, "delivery": "steer"}
            inbox_id = enqueue(sid, item)
            return self.reply(200, {"data": {"id": inbox_id, "sessionID": sid, "time": {"created": ms()},
                                             "type": "user", "payload": {"text": text}, "delivery": "steer"}})
        m = re.fullmatch(r"/api/session/([^/]+)/permission/([^/]+)/reply", path)
        if m:
            with open(os.path.join(ST, f"permission.{m.group(2)}"), "w") as f:
                f.write(body.get("decision", ""))
            emit("permission.replied", {"sessionID": m.group(1), "requestID": m.group(2),
                                        "reply": body.get("decision")})
            return self.reply(204)
        self.reply(404, {"_tag": "NotFound", "message": path})

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        queue = Queue()
        with bus_lock:
            subscribers.append(queue)

        def send(text):
            chunk = text.encode()
            self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
            self.wfile.flush()

        try:
            send("data: " + json.dumps({"id": ident("evt"), "type": "server.connected", "data": {}}) + "\n\n")
            last = time.time()
            while True:
                queue.ready.wait(1.0)
                with bus_lock:
                    pending = list(queue)
                    del queue[:]
                    queue.ready.clear()
                for data in pending:
                    send(f"data: {data}\n\n")
                if time.time() - last >= 10:
                    send(": heartbeat\n\n")
                    last = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with bus_lock:
                if queue in subscribers:
                    subscribers.remove(queue)


def watch_state():
    while os.path.isdir(ST):
        time.sleep(1)
    os._exit(0)


def watch_stdin():
    """With --stdio the server ends when its stdin closes."""
    while sys.stdin.buffer.read(4096):
        pass
    os._exit(0)


signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
threading.Thread(target=watch_state, daemon=True).start()
if STDIO:
    threading.Thread(target=watch_stdin, daemon=True).start()


def start_behaviour():
    """How the start goes (FAKE_OPENCODE_START, as in fake-opencode.py): delay:<s>, never,
    exit:<text>, migrate:<s> (a progress display with carriage returns only)."""
    kind, _, arg = os.environ.get("FAKE_OPENCODE_START", "").partition(":")
    if kind == "exit":
        print(arg or "fatal", file=sys.stderr, flush=True)
        os._exit(1)
    if kind == "never":
        time.sleep(3600)
    if kind in ("delay", "migrate"):
        seconds = float(arg or "1")
        if kind == "migrate":
            for i in range(3):
                sys.stderr.write(f"Migrating database {i * 30}%\r")
                sys.stderr.flush()
                time.sleep(seconds / 3)
            sys.stderr.write("Migrating database 99%")
            sys.stderr.flush()
        else:
            time.sleep(seconds)


start_behaviour()
server = ThreadingHTTPServer((HOST, PORT), Handler)
server.daemon_threads = True
record_call()
url = f"http://{HOST}:{server.server_address[1]}"
print(json.dumps({"url": url}) if STDIO else f"server listening on {url}", flush=True)
server.serve_forever()

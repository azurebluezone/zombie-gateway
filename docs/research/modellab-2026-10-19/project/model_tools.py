#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
model_tools.py — the three local tools the models are allowed to call
====================================================================

    read_file(path)      read a text file (deny-listed secrets refused)
    write_file(path, ..) write a file INSIDE ./workspace only
    run_shell(cmd)       run ONE allow-listed command, no shell interpretation

Design rules (deliberate, not accidental):

* **No shell interpolation.** Commands are split with shlex and executed with
  ``subprocess.run(list, shell=False)``, so ``;`` ``&&`` ``|`` ``$(...)`` and
  backticks have no meaning at all. A model cannot smuggle a second command.
* **Allow-list, not deny-list.** Only commands in ``SHELL_ALLOW`` run. Anything
  else is refused with a message the model can read and adapt to.
* **Interpreters are off by default.** ``python3``/``bash``/``sh``/``perl`` would
  make the allow-list meaningless, so they need MODEL_LAB_ALLOW_INTERPRETERS=1.
* **Writes are sandboxed** to ./workspace, verified with realpath so a symlink
  cannot walk out of the box.
* **Reads are refused for credential-shaped paths** (.ssh, shadow, *.env, keys)
  because the result is shown in a browser and can end up inside a model-written
  HTML page.
* Every call is appended to tool_calls.jsonl — an evidence trail with arguments,
  result size, duration and exit code.

Nothing here talks to the network, and nothing here needs sudo.
"""

import ast
import json
import os
import re
import shlex
import shutil
import subprocess
import time
from datetime import datetime, timedelta, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.join(BASE_DIR, "workspace")
TOOL_LOG = os.path.join(BASE_DIR, "tool_calls.jsonl")

BD_TZ = timezone(timedelta(hours=6))

MAX_READ_BYTES = 200_000          # what we are willing to read from disk
MAX_READ_CHARS = 3_500            # what we hand to the model (its context is small)
MAX_WRITE_BYTES = 512_000
MAX_SHELL_OUTPUT = 2_000          # handed to the model
SHELL_TIMEOUT = 15                # seconds

# Paths whose contents must never travel into a model or a browser.
READ_DENY = (
    "/etc/shadow", "/etc/gshadow", "/etc/sudoers",
    "/.ssh/", "/.gnupg/", "/.aws/", "/.config/opencode/", "/.docker/config.json",
    "id_rsa", "id_ed25519", "id_ecdsa", "authorized_keys",
    ".env", ".netrc", ".pgpass", ".my.cnf", "credentials", "master.key",
)

# Read-only, side-effect-free commands. Adding anything here widens the blast
# radius for every model on this machine, so keep it boring on purpose.
SHELL_ALLOW = {
    "ls", "cat", "head", "tail", "wc", "grep", "find", "echo", "uname",
    "uptime", "df", "free", "date", "pwd", "whoami", "id", "ps", "du",
    "stat", "file", "hostname", "nproc", "sort", "uniq", "cut", "tr",
    "sha256sum", "md5sum", "which", "basename", "dirname", "realpath",
    "lsblk", "java", "tree",
}
# Interpreters: powerful and therefore opt-in only.
SHELL_INTERPRETERS = {"python3", "python", "perl", "ruby", "node", "bash", "sh",
                      "dash", "zsh", "env", "xargs", "awk", "sed"}

# Shell metacharacters. We never pass through a shell, but seeing them means the
# model is *trying* to chain commands — refuse loudly instead of silently
# treating the whole string as one argument.
SHELL_META = re.compile(r"[;&|`$><\n]|\$\(|&&|\|\|")

os.makedirs(WORKSPACE, exist_ok=True)


# --------------------------------------------------------------------------- log
def log_call(entry):
    """Append one tool invocation to tool_calls.jsonl (never raises)."""
    entry = dict(entry)
    entry.setdefault("ts", datetime.now(BD_TZ).isoformat(timespec="seconds"))
    try:
        with open(TOOL_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


# ------------------------------------------------------------------ schemas
def tool_specs():
    """OpenAI/Ollama-style function markers for the three tools."""
    return [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a text file from this machine and return its contents.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string",
                                 "description": "File path. Relative paths resolve inside workspace/."},
                        "max_lines": {"type": "integer",
                                      "description": "Optional limit on lines returned."},
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": ("Create or overwrite a text file inside the workspace "
                                "folder. Use this to produce HTML pages."),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string",
                                 "description": "File name, e.g. page_demo.html"},
                        "content": {"type": "string", "description": "Full file content."},
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_shell",
                "description": ("Run one read-only shell command and return its output. "
                                "Allowed: " + ", ".join(sorted(SHELL_ALLOW))),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": {"type": "string",
                                "description": "Single command, no pipes or ; chaining."},
                    },
                    "required": ["cmd"],
                },
            },
        },
    ]


# Text protocol: for the small models that have no native tool-calling support,
# we ask for a plain-text marker block instead of JSON arguments. Delimiters are
# much easier for a 0.8B model than escaped JSON.
#
# The example path used to read "page_example.html" and deepseek-r1:1.5b copied
# it verbatim instead of the page name given in the task — so no concrete file
# name appears anywhere in this hint any more.
TEXT_PROTOCOL_HINT = """You cannot call functions directly. To use a tool, reply with ONLY this block:

TOOL: write_file
PATH: <the exact path given in the task>
CONTENT:
<the complete file content>
END_CONTENT

Other available tools:
  TOOL: read_file
  PATH: notes.txt

  TOOL: run_shell
  CMD: ls -la

Use the exact path from the task — never invent a file name. Write the block
first, with no explanation before or after it."""


# ------------------------------------------------------------------- helpers
def inside_workspace(path):
    """True when path resolves to something inside ./workspace."""
    try:
        real = os.path.realpath(path)
        root = os.path.realpath(WORKSPACE)
        return real == root or real.startswith(root + os.sep)
    except OSError:
        return False


def resolve_workspace_path(path):
    """Relative paths live in the workspace; absolute paths must stay inside it."""
    path = (path or "").strip().strip('"').strip("'")
    if not path:
        raise ValueError("path is empty")
    if not os.path.isabs(path):
        return os.path.join(WORKSPACE, path)
    return path


def _denied(path):
    low = path.lower()
    for d in READ_DENY:
        if d in low:
            return d
    return None


def _trim(text, limit):
    text = text.strip("\n")
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated, {len(text) - limit} more characters]"


# -------------------------------------------------------------------- READ
def read_file(path="", max_lines=None):
    started = time.time()
    try:
        full = resolve_workspace_path(path)
    except ValueError as exc:
        return _fail("read_file", {"path": path}, str(exc))

    hit = _denied(full)
    if hit:
        log_call({"tool": "read_file", "args": {"path": path}, "status": "denied",
                  "reason": f"secret pattern '{hit}'"})
        return f"REFUSED: reading '{path}' is blocked by policy (matched '{hit}')."

    if not os.path.exists(full):
        return _fail("read_file", {"path": path}, f"no such file: {full}")
    if os.path.isdir(full):
        names = sorted(os.listdir(full))[:60]
        return f"'{full}' is a directory. Entries: {', '.join(names)}"
    if not os.access(full, os.R_OK):
        return _fail("read_file", {"path": path}, "permission denied")

    size = os.path.getsize(full)
    with open(full, "r", encoding="utf-8", errors="replace") as fh:
        data = fh.read(MAX_READ_BYTES)
    if max_lines:
        try:
            data = "\n".join(data.splitlines()[: int(max_lines)])
        except (TypeError, ValueError):
            pass

    log_call({"tool": "read_file", "args": {"path": path}, "status": "ok",
              "bytes_on_disk": size, "chars_returned": len(data),
              "ms": int((time.time() - started) * 1000)})
    header = f"FILE {full} ({size} bytes){' [partial]' if size > MAX_READ_BYTES else ''}\n"
    return header + _trim(data, MAX_READ_CHARS)


# ------------------------------------------------------------------- WRITE
def write_file(path="", content=""):
    started = time.time()
    try:
        full = resolve_workspace_path(path)
    except ValueError as exc:
        return _fail("write_file", {"path": path}, str(exc))

    if not inside_workspace(full):
        log_call({"tool": "write_file", "args": {"path": path}, "status": "denied",
                  "reason": "outside workspace"})
        return (f"REFUSED: writes are only allowed inside {WORKSPACE}. "
                f"Use a plain file name like page_demo.html.")

    if isinstance(content, (dict, list)):
        content = json.dumps(content, ensure_ascii=False, indent=2)
    content = "" if content is None else str(content)
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        return _fail("write_file", {"path": path}, f"content too large (> {MAX_WRITE_BYTES} bytes)")

    os.makedirs(os.path.dirname(full), exist_ok=True)
    prev = os.path.getsize(full) if os.path.exists(full) else None
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(content)

    rel = os.path.relpath(full, WORKSPACE)
    log_call({"tool": "write_file", "args": {"path": rel, "chars": len(content)},
              "status": "ok", "bytes": len(content.encode("utf-8")),
              "replaced_bytes": prev, "ms": int((time.time() - started) * 1000)})
    verb = "OVERWROTE" if prev is not None else "CREATED"
    return (f"OK: {verb} workspace/{rel} ({len(content.encode('utf-8'))} bytes). "
            f"View it at /workspace/{rel}")


# ------------------------------------------------------------------- SHELL
def run_shell(cmd=""):
    started = time.time()
    cmd = (cmd or "").strip()
    if not cmd:
        return _fail("run_shell", {"cmd": cmd}, "empty command")

    if SHELL_META.search(cmd):
        log_call({"tool": "run_shell", "args": {"cmd": cmd}, "status": "denied",
                  "reason": "shell metacharacter"})
        # Measured: llama3.2 asked for "cat /proc/cpuinfo; cat /proc/meminfo; df -h",
        # was refused (correctly) and then *invented* the system specs. The refusal
        # therefore says what to do next instead of only what not to do.
        return ("REFUSED: shell chaining characters (; & | $ > < `) are not allowed. "
                "Send exactly one plain command per call, and call run_shell as many "
                "times as you need — for example: nproc, then free -h, then df -h.")

    try:
        parts = shlex.split(cmd)
    except ValueError as exc:
        return _fail("run_shell", {"cmd": cmd}, f"cannot parse: {exc}")
    if not parts:
        return _fail("run_shell", {"cmd": cmd}, "no command")

    prog = os.path.basename(parts[0])
    allow_interp = os.environ.get("MODEL_LAB_ALLOW_INTERPRETERS") == "1"
    if prog in SHELL_INTERPRETERS and not allow_interp:
        log_call({"tool": "run_shell", "args": {"cmd": cmd}, "status": "denied",
                  "reason": "interpreter disabled"})
        return (f"REFUSED: '{prog}' is an interpreter and is disabled by default "
                f"(set MODEL_LAB_ALLOW_INTERPRETERS=1 to allow it).")
    if prog not in SHELL_ALLOW and prog not in SHELL_INTERPRETERS:
        log_call({"tool": "run_shell", "args": {"cmd": cmd}, "status": "denied",
                  "reason": "not in allow-list"})
        return (f"REFUSED: '{prog}' is not in the allow-list. Allowed commands: "
                + ", ".join(sorted(SHELL_ALLOW)))

    exe = shutil.which(prog)
    if not exe:
        return _fail("run_shell", {"cmd": cmd}, f"'{prog}' not found on PATH")

    try:
        proc = subprocess.run([exe] + parts[1:], cwd=WORKSPACE, shell=False,
                              capture_output=True, text=True, timeout=SHELL_TIMEOUT)
        out = (proc.stdout or "") + (("" if not proc.stderr else "\n[stderr] " + proc.stderr))
        code = proc.returncode
        timed_out = False
    except subprocess.TimeoutExpired:
        out, code, timed_out = f"[timed out after {SHELL_TIMEOUT}s]", -1, True
    except OSError as exc:
        return _fail("run_shell", {"cmd": cmd}, str(exc))

    log_call({"tool": "run_shell", "args": {"cmd": cmd}, "status": "ok",
              "exit": code, "chars": len(out), "timeout": timed_out,
              "ms": int((time.time() - started) * 1000)})
    return f"$ {cmd}\nexit={code}\n" + _trim(out or "(no output)", MAX_SHELL_OUTPUT)


# --------------------------------------------------------------- dispatcher
# ------------------------------------------------- wrong-tool / right-tool help
# What each tool cannot work without, and the argument that is the signature of
# another tool. Measured live (deepseek-r1:1.5b, 2026-10-19): asked to create a
# file it answered "TOOL: run_shell / PATH: live.txt / CONTENT: hello from live" —
# the model chose the wrong name, not the parser. The refusal said only "empty
# command", so it repeated the same block for five rounds (110 s, no file written).
_TOOL_REQUIRED = {"read_file": ("path",), "write_file": ("path",), "run_shell": ("cmd",)}
_RIGHT_TOOL = (("write_file", "content"), ("run_shell", "cmd"), ("read_file", "path"))
_MARKER_TEMPLATE = {
    "write_file": "TOOL: write_file\nPATH: <file name>\nCONTENT:\n<the content>\nEND_CONTENT",
    "read_file": "TOOL: read_file\nPATH: <file name>\nEND_ARGS",
    "run_shell": "TOOL: run_shell\nCMD: <one plain command>\nEND_ARGS",
}


def _mislabel_hint(name, args):
    """Was the tool name wrong for these arguments? Then say which one is right.

    Fires only when the named tool is missing something it cannot work without
    *and* the arguments carry another tool's signature, so a legitimate call with
    a spare field is never redirected. Turning a bare refusal into a correction is
    what breaks the repeat-the-same-wrong-block loop the small models fall into.
    """
    args = args if isinstance(args, dict) else {}
    keys = {k for k, v in args.items() if str(v).strip()}
    required = _TOOL_REQUIRED.get(name)
    if not required or all(k in keys for k in required):
        return None
    for other, signal in _RIGHT_TOOL:
        if other != name and signal in keys:
            return (f"wrong tool for these arguments: '{name}' needs "
                    f"{', '.join(required)} but you sent {sorted(keys)}. "
                    f"Use this block instead:\n{_MARKER_TEMPLATE[other]}")
    return None


def execute(name, args):
    """Run one tool by name. Returns text for the model; never raises."""
    args = args if isinstance(args, dict) else {}
    hint = _mislabel_hint(name, args)
    if hint:
        return _fail(name, args, hint)
    try:
        if name == "read_file":
            return read_file(args.get("path", ""), args.get("max_lines"))
        if name == "write_file":
            return write_file(args.get("path", ""), args.get("content", ""))
        if name == "run_shell":
            return run_shell(args.get("cmd", ""))
        return f"ERROR: unknown tool '{name}'. Available: read_file, write_file, run_shell"
    except Exception as exc:  # noqa: BLE001 — a broken tool must not kill a run
        log_call({"tool": name, "args": args, "status": "error", "error": str(exc)})
        return f"ERROR: tool '{name}' failed: {exc}"


def _fail(name, args, message):
    log_call({"tool": name, "args": args, "status": "error", "error": message})
    return f"ERROR: {message}"


# ----------------------------------------------------- text-protocol parsing
_BLOCK = re.compile(
    r"TOOL\s*:\s*(?P<tool>\w+)\s*\n"
    r"(?P<body>(?:(?!END_CONTENT|END_ARGS|TOOL\s*:).)*?)"
    r"(?:END_CONTENT|END_ARGS|$)",
    re.DOTALL | re.IGNORECASE,
)


def parse_json_tool_args(raw):
    """Best-effort recovery of tool arguments from a string a template mangled.

    Some chat templates hand back ``arguments`` as a string that is not valid
    JSON (single quotes, Python dict syntax, or a whole TOOL: block). Returns a
    dict or None — never raises.
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        got = json.loads(raw)
        if isinstance(got, dict):
            return got
    except json.JSONDecodeError:
        pass
    try:  # Python-style dict: {'path': 'a.html', 'content': 'x'}
        got = ast.literal_eval(raw)
        if isinstance(got, dict):
            return got
    except (ValueError, SyntaxError, TypeError):
        pass
    parsed = parse_text_tool_call(raw)   # the model answered with markers instead
    return parsed[1] if parsed else None


def parse_text_tool_call(text):
    """Pull a TOOL:.../END block out of plain model output.

    Small models cannot always emit JSON with escaped newlines, so the fallback
    protocol uses line markers. Returns (name, args) or None.
    """
    if not text:
        return None
    # Reasoning models wrap their thoughts in  ... : ignore that part.
    body_text = re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", text, flags=re.S | re.I)
    for m in _BLOCK.finditer(body_text):
        tool = m.group("tool").strip().lower()
        body = m.group("body")
        args = {}
        path = re.search(r"^\s*(?:PATH|FILE)\s*:\s*(.+)$", body, re.M | re.I)
        cmd = re.search(r"^\s*(?:CMD|COMMAND)\s*:\s*(.+)$", body, re.M | re.I)
        # re.M so '^' can sit on its own line, re.S so the content swallows the
        # rest of the block including newlines. Missing either one silently
        # returned None for every write_file call.
        content = re.search(r"^\s*CONTENT\s*:\s*\n?(.*)$", body, re.M | re.S | re.I)
        if path:
            args["path"] = path.group(1).strip().strip('"').strip("'")
        if cmd:
            args["cmd"] = cmd.group(1).strip()
        if content:
            args["content"] = content.group(1).rstrip()
        if tool == "write_file" and args.get("path") and "content" in args:
            return tool, args
        if tool == "read_file" and args.get("path"):
            return tool, args
        if tool == "run_shell" and args.get("cmd"):
            return tool, args
    return None


def parse_json_block_tool_call(text):
    """Rescue a tool call the model wrote as (usually invalid) JSON.

    Measured, not hypothetical. deepseek-r1:1.5b replies to a tool request with:

        ```json
        { "write_file": { "path": "page_x.html", "content": "<!DOCTYPE html>
        <html> ...un-escaped real newlines inside the string... " } }
        ```

    No JSON parser accepts that, so the model's work would be thrown away. The
    two fields are therefore pulled apart by hand and unescaped as well as can
    be. Anything questionable simply fails to produce a usable call and the
    normal flow continues. Returns (name, args) or None.
    """
    if not text:
        return None
    body = re.sub(r"```[a-zA-Z]*", "", text)          # drop code fences
    body = re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", body, flags=re.S | re.I)

    tool = None
    chunk = ""
    m = re.search(r'"(read_file|write_file|run_shell)"\s*:\s*\{', body, re.I)
    if m:
        tool = m.group(1).lower()
        chunk = body[m.end():]
    else:
        m = re.search(r'"name"\s*:\s*"(read_file|write_file|run_shell)"', body, re.I)
        if m:
            tool = m.group(1).lower()
            chunk = body[m.end():]
    if not tool:
        return None

    args = {}
    p = re.search(r'"path"\s*:\s*"([^"]*)"', chunk, re.I)
    if p:
        args["path"] = p.group(1)
    c = re.search(r'"cmd"\s*:\s*"(.*?)(?<!\\)"', chunk, re.S | re.I)
    if c:
        args["cmd"] = _unescape_jsonish(c.group(1))
    cm = re.search(r'"content"\s*:\s*"(.*)$', chunk, re.S | re.I)
    if cm:
        raw = cm.group(1)
        cut = raw.rfind('"')             # the value ends at its closing quote
        if cut != -1:
            raw = raw[:cut]
        args["content"] = _unescape_jsonish(raw).rstrip().rstrip("}").rstrip()

    if tool == "write_file" and args.get("path") and args.get("content"):
        return tool, args
    if tool == "read_file" and args.get("path"):
        return tool, args
    if tool == "run_shell" and args.get("cmd"):
        return tool, args
    return None


def _unescape_jsonish(value):
    """Turn \\n, \\" and friends back into real characters (never raises)."""
    out, i = [], 0
    mapping = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\",
               "'": "'", "/": "/", "b": "\b", "f": "\f"}
    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            out.append(mapping.get(value[i + 1], value[i + 1]))
            i += 2
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


_LEARNED_CACHE = {"mtime": None, "grammars": []}


def _learned_grammars():
    """Grammar set the lab taught itself from real model output.

    Source: ``lab_data/dialect_memory.json``, written by ``dialect_lab.py learn``
    (that module probes the local models and *induces* their tool-call dialect —
    envelope, payload shape, terminator — instead of a human writing a parser).
    Re-read whenever the file changes, so a newly learned dialect is picked up
    without touching this file. Any failure returns no grammars: this is a bonus
    layer and must never be a reason for parsing to break.
    """
    path = os.path.join(BASE_DIR, "lab_data", "dialect_memory.json")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return []
    if _LEARNED_CACHE["mtime"] == mtime:
        return _LEARNED_CACHE["grammars"]
    grammars = []
    try:
        with open(path, encoding="utf-8") as fh:
            memory = (json.load(fh) or {}).get("memory") or {}
        for entry in memory.values():
            for gram in entry.get("grammar_set") or []:
                if isinstance(gram, dict) and gram.get("kind") not in (None, "native"):
                    grammars.append(gram)
    except (OSError, ValueError, AttributeError):
        grammars = []
    _LEARNED_CACHE.update({"mtime": mtime, "grammars": grammars})
    return grammars


def _guess_tool_from_args(args):
    """Which tool did the model mean when it omitted the name (flat-JSON dialects)?

    ``cmd`` can only be run_shell, ``content`` only write_file, a bare ``path``
    only read_file. This is an inference, not a fact, and it is only reached when
    the model left the name out entirely.
    """
    if "cmd" in args:
        return "run_shell"
    if "content" in args:
        return "write_file"
    if "path" in args:
        return "read_file"
    return None


def parse_learned_dialect(text):
    """Third layer: dialects the lab induced from the models' own behaviour."""
    if not text or not text.strip():
        return None
    grammars = _learned_grammars()
    if not grammars:
        return None
    try:
        import dialect_lab
    except ImportError:
        return None
    for gram in grammars:
        try:
            calls = dialect_lab.parse_calls(text, gram, None)
        except Exception:  # noqa: BLE001 — a broken grammar must not break the lab
            continue
        if not calls:
            continue
        name, args = calls[0]
        return (name or _guess_tool_from_args(args)), args
    return None


def parse_any_tool_call(text):
    """Every text-side protocol in order: markers, JSON-ish, then learned.

    The first two layers are the original hand-written chain and are untouched —
    the learned layer only runs when both of them found nothing, so existing
    behaviour cannot regress (proved in lab_data/parse_layers_test.txt).
    """
    return (parse_text_tool_call(text) or parse_json_block_tool_call(text)
            or parse_learned_dialect(text))


def workspace_listing():
    """Files currently in ./workspace, newest first (for the browser panel)."""
    out = []
    for root, _dirs, files in os.walk(WORKSPACE):
        for fn in files:
            full = os.path.join(root, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            out.append({
                "name": os.path.relpath(full, WORKSPACE),
                "bytes": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime, BD_TZ).isoformat(timespec="seconds"),
                "mtime_epoch": st.st_mtime,
            })
    out.sort(key=lambda x: x["mtime_epoch"], reverse=True)
    return out


if __name__ == "__main__":  # tiny self-test: python3 model_tools.py
    print("workspace:", WORKSPACE)
    print("tools:", [t["function"]["name"] for t in tool_specs()])
    print(execute("run_shell", {"cmd": "uname -a"})[:200])
    print(execute("run_shell", {"cmd": "ls; rm -rf /"})[:160])
    print(execute("write_file", {"path": "_selftest.txt", "content": "hello"}))
    print(execute("read_file", {"path": "_selftest.txt"})[:120])
    print("text-proto:", parse_text_tool_call(
        "TOOL: write_file\nPATH: a.html\nCONTENT:\n<h1>hi</h1>\nEND_CONTENT"))

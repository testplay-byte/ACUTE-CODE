#!/usr/bin/env python3
"""R94-A regression tests — the launcher's divergence-aware update path.

The round-94 owner field report (v0.91.0): after the repository went PUBLIC
(the v0.91.0 migration REWROTE the git history), every pre-existing clone
diverged from remote main and the launcher's update died with a dead-end
FAILED panel — `git pull --ff-only` answered "fatal: Not possible to
fast-forward, aborting." The same report flagged the launcher warning
"GitHub reports this repository as PUBLIC — please flag this to the owner
(closed-source repo)" although PUBLIC is now the intended state.

These tests load the REAL launcher module (same import-safe pattern as
test_pick_latest_release.py — module level is constants + pure definitions
only) and pin the R94-A contract:
  · repo_state reports "ahead" (FETCH_HEAD..HEAD) next to "behind" (0 when
    GitHub is unreachable — divergence needs a FETCH_HEAD to compare to);
  · a DIVERGED state (behind>0 AND ahead>0) realigns with
    `git reset --hard FETCH_HEAD` (never a pull), logs WHY before doing it,
    and reports "updated (realigned) · old → new";
  · a pure-behind state (ahead == 0) still fast-forwards via
    `git pull --ff-only` — the untouched happy path;
  · stop_live_servers("applying update") still runs before the update;
  · an update FAILURE on a machine with an existing local build WARNs and
    CONTINUES (no SystemExit; returns False = "not updated, don't rebuild"
    for install_and_build) — with the token-bearing URL REDACTED out of the
    warning; only a machine with NOTHING to run (a failed FRESH clone, or a
    checkout that was never built) still hard-fails;
  · a PUBLIC repository is the healthy path in validate_github_access: a
    dim note (never a warn) and True — the token keeps working either way.

Run (repo root):      python -m unittest discover -s launcher/tests -v
Run (anywhere):       python launcher/tests/test_update_divergence.py
CI: wired into .github/workflows/ci.yml (the push gate) and release.yml's
launcher-kit quality gate via the same discovery command as R74's picker
and R90-B1's token-path suites (discovery runs every launcher/tests/
test_*.py file — no workflow change needed for this file to run there).
"""
import contextlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_LAUNCHER = Path(__file__).resolve().parents[1] / "acute_launcher.py"
_SPEC = importlib.util.spec_from_file_location("acute_launcher_r94a_under_test", _LAUNCHER)
LAUNCHER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(LAUNCHER)

_PAT = "github_pat_r94a_realignment_day"
_AUTHED_URL = LAUNCHER.authed_url(_PAT)  # the token-bearing URL — must never leak


class FakeProc:
    """The subprocess.CompletedProcess subset the launcher reads."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeGit:
    """Stands in for the launcher's run() — answers each git command from a
    scripted per-subcommand queue and records every call (plus a unified
    event stream shared with the patched ok/warn/note so tests can assert
    ORDER, e.g. "the why-note printed BEFORE the reset ran").

    Keys: ("rev-parse",) ("status",) ("fetch",) ("pull",) ("reset",)
    ("clone",) … — and ("rev-list", "<range>") so behind (HEAD..FETCH_HEAD)
    and ahead (FETCH_HEAD..HEAD) can differ. Each scripted value pops per
    call; an exhausted/absent key answers a clean success with empty output.
    """

    def __init__(self, script=None, events=None):
        self.script = {k: list(v) for k, v in (script or {}).items()}
        self.calls = []
        self.events = events if events is not None else []

    def __call__(self, cmd, cwd=None, env=None, check=True, timeout=None):
        argv = [str(a) for a in cmd]
        self.calls.append(argv)
        self.events.append(("git", argv))
        if argv[:2] == ["git", "rev-list"]:
            key = ("rev-list", argv[-1])
        elif argv and argv[0] == "git":
            key = (argv[1],)
        else:
            key = ("cmd", argv[0] if argv else "")
        queue = self.script.get(key)
        if queue:
            return queue.pop(0)
        return FakeProc(0)


class _UpdateTestCase(unittest.TestCase):
    """Shared isolation for the repo_state / clone_or_update contract."""

    def setUp(self):
        # ── isolation: a temp APP_DIR stands in for the checkout next to ──
        # the launcher; run/step/probe/ok/warn/note/log/fail/wait_close are
        # patched so nothing touches the real kit folder, the network, or
        # the terminal (the same hermeticity rule as test_github_pat).
        self._tmp = tempfile.TemporaryDirectory(prefix="acute-r94a-")
        self.addCleanup(self._tmp.cleanup)
        self._app = Path(self._tmp.name) / "ACUTE-CODE"
        self._saved_app_dir = LAUNCHER.APP_DIR
        LAUNCHER.APP_DIR = self._app

        # Recording UI + a unified event stream (git calls land in it too)
        # so tests can assert what was shown AND in what order.
        self.events = []
        self.oks, self.warns, self.notes, self.logged = [], [], [], []

        def _rec(bucket, kind):
            def f(msg):
                bucket.append(msg)
                self.events.append((kind, msg))
            return f

        self.fails = []
        self.stops = []
        self._saved = {
            name: getattr(LAUNCHER, name)
            for name in ("run", "ok", "warn", "note", "log", "step", "probe",
                         "fail", "wait_close", "check_disk_space",
                         "stop_live_servers")
        }
        self._saved_secrets = list(LAUNCHER.SECRETS_TO_REDACT)
        LAUNCHER.ok = _rec(self.oks, "ok")
        LAUNCHER.warn = _rec(self.warns, "warn")
        LAUNCHER.note = _rec(self.notes, "note")
        LAUNCHER.log = self.logged.append
        LAUNCHER.step = lambda name="": contextlib.nullcontext()
        LAUNCHER.probe = lambda cmd, timeout=20: (None, "")
        LAUNCHER.check_disk_space = lambda need_gb=2.0: None
        LAUNCHER.stop_live_servers = lambda reason: self.stops.append(reason)
        LAUNCHER.wait_close = lambda: None

        def _fail(where, detail):
            self.fails.append((where, str(detail)))
            raise SystemExit(1)

        LAUNCHER.fail = _fail
        self.addCleanup(self._restore)

    def _restore(self):
        LAUNCHER.APP_DIR = self._saved_app_dir
        for name, fn in self._saved.items():
            setattr(LAUNCHER, name, fn)
        LAUNCHER.SECRETS_TO_REDACT[:] = self._saved_secrets

    # ── fixtures ─────────────────────────────────────────────────────────

    def _plant_local_build(self):
        """A previously-installed app: a git checkout + the built bundle —
        exactly _local_build_available()'s two signals."""
        (self._app / ".git").mkdir(parents=True, exist_ok=True)
        mainjs = self._app / "agent-core" / "dist" / "main.js"
        mainjs.parent.mkdir(parents=True, exist_ok=True)
        mainjs.write_text("/* built */\n", encoding="utf-8")
        self.assertTrue(LAUNCHER._local_build_available())

    def _patch_run(self, script):
        git = FakeGit(script, events=self.events)
        LAUNCHER.run = git
        return git

    def _state_script(self, *, head="old123", new_head="new456", status="",
                      behind="5", ahead="0", fetch_code=0):
        """The repo_state dialogue + the post-update HEAD probe."""
        return {
            ("rev-parse",): [FakeProc(0, stdout=head + "\n"),
                              FakeProc(0, stdout=new_head + "\n")],
            ("status",): [FakeProc(0, stdout=status)],
            ("fetch",): [FakeProc(fetch_code,
                                 stderr="" if fetch_code == 0 else
                                 "fatal: Could not resolve host github.com")],
            ("rev-list", "HEAD..FETCH_HEAD"): [FakeProc(0, stdout=behind + "\n")],
            ("rev-list", "FETCH_HEAD..HEAD"): [FakeProc(0, stdout=ahead + "\n")],
        }


class RepoStateAheadTests(_UpdateTestCase):
    """repo_state must measure BOTH directions of the divergence."""

    def test_reports_ahead_next_to_behind(self):
        git = self._patch_run(self._state_script(behind="37", ahead="12"))
        state = LAUNCHER.repo_state(_PAT, {})
        self.assertEqual(
            state, {"head": "old123", "behind": 37, "ahead": 12, "dirty": False}
        )
        # both counts really asked git for their own range
        self.assertIn(["git", "rev-list", "--count", "HEAD..FETCH_HEAD"], git.calls)
        self.assertIn(["git", "rev-list", "--count", "FETCH_HEAD..HEAD"], git.calls)

    def test_unreachable_github_defaults_ahead_to_zero(self):
        """The offline contract: behind = -1 (the caller returns early) and
        ahead = 0 — divergence can only be judged against a FETCH_HEAD the
        fetch actually produced."""
        git = self._patch_run(self._state_script(fetch_code=128))
        state = LAUNCHER.repo_state(_PAT, {})
        self.assertEqual(
            state, {"head": "old123", "behind": -1, "ahead": 0, "dirty": False}
        )
        self.assertFalse(any(c[1] == "rev-list" for c in git.calls))

    def test_dirty_tree_is_reported(self):
        git = self._patch_run(self._state_script(status=" M src/index.ts\n"))
        state = LAUNCHER.repo_state(_PAT, {})
        self.assertTrue(state["dirty"])


class CloneOrUpdateDivergenceTests(_UpdateTestCase):
    """THE owner bug: behind>0 AND ahead>0 must realign, not dead-end."""

    def test_diverged_history_realigns_with_reset_hard_fetch_head(self):
        """The v0.91.0 public migration rewrote the history — the owner's
        clone sat at behind=37, ahead=12 and `git pull --ff-only` could only
        answer "fatal: Not possible to fast-forward, aborting." The launcher
        must realign via `git reset --hard FETCH_HEAD` (the fetch repo_state
        just did), say WHY before doing it, and finish the update."""
        self._plant_local_build()
        script = self._state_script(behind="37", ahead="12", new_head="pub999")
        script[("reset",)] = [FakeProc(0, stdout="HEAD is now at pub999\n")]
        git = self._patch_run(script)

        updated = LAUNCHER.clone_or_update(_PAT, {})

        self.assertTrue(updated)
        self.assertIn(["git", "reset", "--hard", "FETCH_HEAD"], git.calls)
        self.assertFalse(any(c[1] == "pull" for c in git.calls),
                         "a diverged history must NOT be pulled — the reset realigns it")
        # the WHY is told BEFORE the reset runs (unified event stream order)
        why = next(i for i, (k, m) in enumerate(self.events)
                   if k == "note" and "diverged" in m and "rewrote its history" in m)
        reset = next(i for i, (k, v) in enumerate(self.events)
                     if k == "git" and v[1] == "reset")
        self.assertLess(why, reset)
        self.assertTrue(any("nothing outside ACUTE-CODE/ is touched" in m
                            for m in self.notes))
        # the report names the realignment + both ends
        self.assertTrue(any("updated (realigned)" in m and "old123" in m and "pub999" in m
                            for m in self.oks))
        # the reset only ever happens after the servers were stopped
        self.assertEqual(self.stops, ["applying update"])

    def test_pure_behind_still_fast_forward_pulls(self):
        """ahead == 0 (the common case): the untouched happy path —
        `git pull --ff-only <authed> main`, never a reset."""
        self._plant_local_build()
        script = self._state_script(behind="5", ahead="0")
        script[("pull",)] = [FakeProc(0, stdout="Fast-forward\n")]
        git = self._patch_run(script)

        updated = LAUNCHER.clone_or_update(_PAT, {})

        self.assertTrue(updated)
        self.assertIn(["git", "pull", "--ff-only", _AUTHED_URL, "main"], git.calls)
        self.assertFalse(any(c[1] == "reset" for c in git.calls))
        self.assertTrue(any("updated" in m and "old123" in m and "new456" in m
                            for m in self.oks))
        self.assertFalse(any("realigned" in m for m in self.oks))
        self.assertEqual(self.stops, ["applying update"])

    def test_update_failure_with_local_build_warns_and_continues(self):
        """R94-A's never-dead-end rule: the pull fails (network here), but a
        local build exists (.git + agent-core/dist/main.js) — so warn with
        the diagnosis (REDACTED — git echoes the token-bearing URL in some
        errors) + note the fallback, return False ("not updated, don't
        rebuild") and DO NOT fail()."""
        self._plant_local_build()
        LAUNCHER.register_secrets(_AUTHED_URL)  # what main() registers at boot
        script = self._state_script(behind="5", ahead="0", new_head="old123")
        script[("pull",)] = [FakeProc(
            128,
            stderr=f"fatal: unable to access '{_AUTHED_URL}': "
                   f"Could not resolve host github.com\n",
        )]
        self._patch_run(script)

        updated = LAUNCHER.clone_or_update(_PAT, {})

        self.assertFalse(updated, "a failed update means 'don't rebuild' — "
                                  "install_and_build keeps the existing build")
        self.assertEqual(self.fails, [], "a machine with a local build is never dead-ended")
        self.assertTrue(any("Could not resolve host" in w for w in self.warns),
                        "the git diagnosis is shown in the warning")
        self.assertTrue(any("continuing with the currently installed version" in m
                            and "retry next run" in m for m in self.notes))
        for w in self.warns:  # the token never reaches the output
            self.assertNotIn(_PAT, w)
            self.assertNotIn(_AUTHED_URL, w)

    def test_realignment_failure_with_local_build_also_continues(self):
        """The same never-dead-end rule on the reset path: a diverged
        checkout whose reset fails warns and boots the installed version."""
        self._plant_local_build()
        script = self._state_script(behind="37", ahead="12", new_head="old123")
        script[("reset",)] = [FakeProc(128, stderr="fatal: ambiguous argument\n")]
        self._patch_run(script)

        updated = LAUNCHER.clone_or_update(_PAT, {})

        self.assertFalse(updated)
        self.assertEqual(self.fails, [])
        self.assertTrue(any("ambiguous argument" in w for w in self.warns))
        self.assertTrue(any("continuing with the currently installed version" in m
                            for m in self.notes))

    def test_update_failure_without_local_build_still_fails(self):
        """The soft path's boundary: a checkout that was cloned but never
        BUILT has nothing to boot — the update failure stays a hard fail."""
        (self._app / ".git").mkdir(parents=True)  # cloned, never built
        self.assertFalse(LAUNCHER._local_build_available())
        script = self._state_script(behind="5", ahead="0")
        script[("pull",)] = [FakeProc(128, stderr="fatal: read error\n")]
        self._patch_run(script)

        with self.assertRaises(SystemExit):
            LAUNCHER.clone_or_update(_PAT, {})
        self.assertEqual(len(self.fails), 1)
        self.assertEqual(self.fails[0][0], "updating ACUTE-CODE to the latest version")

    def test_fresh_clone_failure_still_hard_fails(self):
        """No local copy at all (first run, the clone itself dies) — the ONE
        case the spec keeps as a hard fail: there is nothing to continue."""
        self.assertFalse(self._app.exists())
        script = {
            ("clone",): [FakeProc(
                128,
                stderr="fatal: repository "
                       "'https://github.com/testplay-byte/ACUTE-CODE.git/' not found\n",
            )],
        }
        self._patch_run(script)

        with self.assertRaises(SystemExit):
            LAUNCHER.clone_or_update(_PAT, {})
        self.assertEqual(len(self.fails), 1)
        self.assertEqual(self.fails[0][0], "downloading the ACUTE-CODE repository")
        self.assertIn("not found", self.fails[0][1])


class ValidateGithubAccessPublicTests(unittest.TestCase):
    """R94-A: PUBLIC is the intended repository state — a note, never a warn."""

    def setUp(self):
        self.oks, self.warns, self.notes = [], [], []
        self._saved = {name: getattr(LAUNCHER, name)
                       for name in ("ok", "warn", "note", "log", "wait_close")}
        LAUNCHER.ok = self.oks.append
        LAUNCHER.warn = self.warns.append
        LAUNCHER.note = self.notes.append
        LAUNCHER.log = lambda msg: None
        LAUNCHER.wait_close = lambda: None
        self.addCleanup(self._restore)

    def _restore(self):
        for name, fn in self._saved.items():
            setattr(LAUNCHER, name, fn)

    @staticmethod
    def _urlopen_returning(body):
        payload = json.dumps(body).encode("utf-8")

        class _Resp:  # the context-manager surface urlopen() is used with
            def read(self):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return _Resp()

    def test_public_repo_is_a_note_never_a_warning(self):
        """THE report item: the launcher warned "GitHub reports this
        repository as PUBLIC — please flag this to the owner (closed-source
        repo)". Public is now correct — dim note, green ok, no warning,
        token still accepted."""
        with mock.patch("urllib.request.urlopen",
                        return_value=self._urlopen_returning({"private": False})):
            result = LAUNCHER.validate_github_access(_PAT)

        self.assertIs(result, True)
        self.assertEqual(self.warns, [], "a public repository must not warn")
        self.assertTrue(any("public" in m and "anonymous GitHub access works" in m
                            and "rate limits" in m for m in self.notes),
                        "the positive note explains what the token is still for")
        self.assertTrue(any("public" in m and "token accepted" in m for m in self.oks))

    def test_private_repo_answer_still_quiet_and_true(self):
        """The neutral wording works both ways: a private answer is equally
        healthy — accepted, no warning, no divergence note."""
        with mock.patch("urllib.request.urlopen",
                        return_value=self._urlopen_returning({"private": True})):
            result = LAUNCHER.validate_github_access(_PAT)

        self.assertIs(result, True)
        self.assertEqual(self.warns, [])
        self.assertEqual(self.notes, [])
        self.assertTrue(any("private" in m and "token accepted" in m for m in self.oks))


if __name__ == "__main__":
    unittest.main(verbosity=2)

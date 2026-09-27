#!/usr/bin/env python3
"""R131-U regression tests — the desktop update CALM (launcher side).

The round-131 owner verdict on the v0.123.0 update: "the updating process
was not that smooth… way too jittery… if it requires the admin permissions,
then it should ask for the admin permissions from the user too." These
tests load the REAL launcher module (the same import-safe pattern as
test_pick_latest_release.py / test_update_divergence.py) and pin the three
launcher-side halves of the calm:

  · THE ELEVATION LEG (_desktop_install): a failed silent install with the
    write-failure shape (non-zero exit; access-denied markers in a captured
    stderr, or the honest empty capture a silent NSIS leaves) asks ONCE for
    administrator permission via _run_installer_elevated — the OS's own UAC
    consent dialog IS the ask. A healthy install (exit 0), a timeout, and a
    non-marker stderr NEVER elevate (no gratuitous UAC — the per-user
    default stays). A declined consent fails honestly with the reason.
  · THE SINGLE RETRY (desktop_flow): a fresh install that does not verify
    gets EXACTLY ONE full delete-and-reinstall retry — never the repeating
    churn — then the honest give-up whose note says the next run will ASK.
  · THE OPT-IN REPAIR (desktop_flow): the sticky repair flag no longer
    forces a silent full cycle on a normal run. An approved ask runs the
    cycle once; a declined ask clears the flag with the honest warn; a
    non-interactive run (no tty — this suite) keeps the flag and NEVER
    uninstalls. `ACUTE.bat reinstall` stays the explicit door.

Run (repo root):      python -m unittest discover -s launcher/tests -v
Run (anywhere):       python launcher/tests/test_desktop_update_calm.py
CI: wired into .github/workflows/ci.yml (the push gate) and release.yml's
launcher-kit quality gate via the same discovery command as the R74/R90-B1/
R94-A suites (discovery runs every launcher/tests/test_*.py file).
"""
import contextlib
import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest import mock

_LAUNCHER = Path(__file__).resolve().parents[1] / "acute_launcher.py"
_SPEC = importlib.util.spec_from_file_location("acute_launcher_r131u_under_test", _LAUNCHER)
LAUNCHER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(LAUNCHER)

_VERSION = "0.124.0"
_INSTALLER = Path("/tmp/fake/ACUTE-CODE_0.124.0_x64-setup.exe")


def _lines(bucket):
    """The recorded message strings from a patched ok/warn/note recorder."""
    return [args[0] if args else "" for args, _ in bucket]


class _UiTestCase(unittest.TestCase):
    """The hermeticity rule (test_github_pat's): every terminal seam the
    touched code touches is patched before the code runs."""

    def setUp(self):
        self.oks, self.warns, self.notes = [], [], []
        self.saved_ui = {name: getattr(LAUNCHER, name)
                         for name in ("ok", "warn", "note", "log", "step", "panel",
                                      "wait_close", "fail")}
        LAUNCHER.ok = lambda *a, **k: self.oks.append(a[0] if a else "")
        LAUNCHER.warn = lambda *a, **k: self.warns.append(a[0] if a else "")
        LAUNCHER.note = lambda *a, **k: self.notes.append(a[0] if a else "")
        LAUNCHER.log = lambda *a, **k: None
        LAUNCHER.step = lambda name="": contextlib.nullcontext()
        LAUNCHER.panel = lambda *a, **k: None
        LAUNCHER.wait_close = lambda: None
        LAUNCHER.fail = lambda *a, **k: None
        self.addCleanup(self._restore_ui)

    def _restore_ui(self):
        for name, fn in self.saved_ui.items():
            setattr(LAUNCHER, name, fn)


class ElevatedRetryDecisionTests(unittest.TestCase):
    """_should_retry_install_elevated — the pure truth table."""

    def test_healthy_install_never_elevates(self):
        self.assertFalse(LAUNCHER._should_retry_install_elevated(0, ""))
        self.assertFalse(LAUNCHER._should_retry_install_elevated(0, "access is denied"))

    def test_nonzero_exit_with_silent_stderr_is_the_write_failure_shape(self):
        """A silent NSIS prints NOTHING — the exit code IS the signal."""
        self.assertTrue(LAUNCHER._should_retry_install_elevated(1, ""))
        self.assertTrue(LAUNCHER._should_retry_install_elevated(2, None))

    def test_access_denied_markers_in_captured_stderr_sharpen_the_case(self):
        self.assertTrue(LAUNCHER._should_retry_install_elevated(1, "Access is denied."))
        self.assertTrue(LAUNCHER._should_retry_install_elevated(1, "Installer Error 740"))
        self.assertEqual(
            LAUNCHER._installer_access_denied_markers("Error 5 occurred"),
            ["error 5"],
        )

    def test_nonmarker_stderr_is_a_different_failure_no_uac(self):
        self.assertFalse(LAUNCHER._should_retry_install_elevated(1, "corrupt cabinet file"))
        self.assertFalse(LAUNCHER._should_retry_install_elevated(1, "NSIS Error: installation aborted"))


class DesktopInstallElevationTests(_UiTestCase):
    """_desktop_install — the ONE elevated retry, fired only on the shape."""

    def setUp(self):
        super().setUp()
        self.elevated_calls = []
        self._real_elevated = LAUNCHER._run_installer_elevated
        self._elevated_result = (True, "the elevated install completed")

        def _elevated(installer_path, timeout_s=None):
            self.elevated_calls.append((installer_path, timeout_s))
            return self._elevated_result

        LAUNCHER._run_installer_elevated = _elevated
        self.addCleanup(self._restore_elevated)

    def _restore_elevated(self):
        LAUNCHER._run_installer_elevated = self._real_elevated

    def _patch_installer_run(self, returncode=0, stderr="", exc=None):
        fake = subprocess.CompletedProcess([], returncode, stdout="", stderr=stderr)
        patcher = mock.patch(
            "subprocess.run",
            **({"side_effect": exc} if exc is not None else {"return_value": fake}),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_failed_silent_install_asks_once_and_succeeds_elevated(self):
        """THE elevation leg: exit 1 with a silent (empty) capture -> ONE
        _run_installer_elevated call (the UAC consent IS the ask) -> True."""
        self._patch_installer_run(returncode=1, stderr="")
        self.assertTrue(LAUNCHER._desktop_install(_INSTALLER))
        self.assertEqual(self.elevated_calls, [(_INSTALLER, None)])
        self.assertTrue(any("asking once for administrator permission" in m for m in self.oks))
        self.assertTrue(any("may need administrator permission" in m for m in self.warns))
        self.assertTrue(any("the elevated install succeeded" in m for m in self.oks))

    def test_declined_consent_fails_honestly_with_the_reason(self):
        self._patch_installer_run(returncode=1, stderr="")
        self._elevated_result = (False, "the consent dialog was declined (or the elevated launch was refused)")
        self.assertFalse(LAUNCHER._desktop_install(_INSTALLER))
        self.assertTrue(any("the elevated retry failed — the consent dialog was declined" in m
                            for m in self.warns))

    def test_healthy_install_never_elevates(self):
        self._patch_installer_run(returncode=0)
        self.assertTrue(LAUNCHER._desktop_install(_INSTALLER))
        self.assertEqual(self.elevated_calls, [])

    def test_timeout_never_elevates_not_an_access_problem(self):
        self._patch_installer_run(exc=subprocess.TimeoutExpired(cmd="x", timeout=600))
        self.assertFalse(LAUNCHER._desktop_install(_INSTALLER))
        self.assertEqual(self.elevated_calls, [])
        self.assertTrue(any("not an access problem; no elevation retry" in m for m in self.notes))

    def test_nonmarker_stderr_fails_without_elevation(self):
        self._patch_installer_run(returncode=1, stderr="corrupt cabinet file")
        self.assertFalse(LAUNCHER._desktop_install(_INSTALLER))
        self.assertEqual(self.elevated_calls, [])
        self.assertTrue(any("corrupt cabinet file" in m for m in self.notes))

    def test_permission_error_on_execute_retries_elevated(self):
        self._patch_installer_run(exc=PermissionError(5, "Access is denied"))
        self.assertTrue(LAUNCHER._desktop_install(_INSTALLER))
        self.assertEqual(self.elevated_calls, [(_INSTALLER, None)])
        self.assertTrue(any("asking once for administrator permission" in m for m in self.warns))


class AskRepairNowTests(unittest.TestCase):
    """_ask_repair_now — the tri-state ask (this suite runs without a tty)."""

    def test_noninteractive_answers_none_and_the_confirm_is_never_reached(self):
        with mock.patch.object(LAUNCHER.sys.stdin, "isatty", return_value=False):
            self.assertIsNone(LAUNCHER._ask_repair_now("0.123.0", _VERSION))

    def test_interactive_ask_is_a_plain_confirm_defaulting_to_repair(self):
        with mock.patch.object(LAUNCHER.sys.stdin, "isatty", return_value=True), \
                mock.patch.object(LAUNCHER, "confirm", return_value=True) as asked:
            self.assertTrue(LAUNCHER._ask_repair_now("0.123.0", _VERSION))
        self.assertEqual(asked.call_count, 1)
        question = asked.call_args[0][0]
        self.assertIn("ran engine 0.123.0 instead of 0.124.0", question)
        self.assertEqual(asked.call_args[1], {"default": True})


class _FakeProc:
    """The Popen surface desktop_flow reads (pid/poll/wait)."""

    def __init__(self):
        self.pid = 4242

    def poll(self):
        return None

    def wait(self):
        return 0


class DesktopFlowCalmTests(_UiTestCase):
    """desktop_flow's calm law: ONE retry, and the repair is OPT-IN."""

    def setUp(self):
        super().setUp()
        self.installs = []
        self.uninstalls = []
        self.flags_written = []
        self.flags_cleared = 0
        self.installed_script = []
        self.exe_version_script = []
        self.engine_version = _VERSION

        flow_seams = (
            "_desktop_latest_release", "_desktop_download", "_desktop_install_files",
            "_desktop_stop_running", "_desktop_wait_for_exit", "_print_whats_new",
            "_desktop_watch_engine", "_write_repair_flag", "_clear_repair_flag",
            "_desktop_install", "_desktop_uninstall", "_desktop_find_installed",
            "_desktop_exe_version", "_read_repair_flag",
        )
        self.saved_flow = {name: getattr(LAUNCHER, name) for name in flow_seams}
        self.addCleanup(self._restore_flow)

        LAUNCHER._desktop_latest_release = lambda pat: (
            _VERSION, 4321, "sha256:" + "a" * 64, {"tag": "v" + _VERSION, "draft": False})
        LAUNCHER._desktop_download = lambda pat, asset_id, version, digest="": _INSTALLER
        LAUNCHER._desktop_install_files = lambda installed: (
            Path(installed["location"]) / "ACUTE-CODE.exe", [])
        LAUNCHER._desktop_stop_running = lambda installed: None
        LAUNCHER._desktop_wait_for_exit = lambda installed, timeout_s=20: True
        LAUNCHER._print_whats_new = lambda version: None
        LAUNCHER._desktop_watch_engine = lambda proc, timeout_s=75: ("up", self.engine_version)
        LAUNCHER._read_repair_flag = lambda: None
        LAUNCHER._write_repair_flag = lambda expected: self.flags_written.append(expected)
        LAUNCHER._clear_repair_flag = lambda: setattr(self, "flags_cleared", self.flags_cleared + 1)

        def _install(installer):
            self.installs.append(str(installer))
            return True

        def _uninstall(installed):
            self.uninstalls.append(installed["version"])
            return True

        def _find_installed():
            return self.installed_script.pop(0) if self.installed_script else None

        def _exe_version(exe):
            return self.exe_version_script.pop(0) if self.exe_version_script else _VERSION

        LAUNCHER._desktop_install = _install
        LAUNCHER._desktop_uninstall = _uninstall
        LAUNCHER._desktop_find_installed = _find_installed
        LAUNCHER._desktop_exe_version = _exe_version

        popen = mock.patch("subprocess.Popen", return_value=_FakeProc())
        popen.start()
        self.addCleanup(popen.stop)

    def _restore_flow(self):
        for name, fn in self.saved_flow.items():
            setattr(LAUNCHER, name, fn)

    def _current(self, version=_VERSION, location="/opt/fake"):
        return {"version": version, "location": location}

    # ── THE SINGLE RETRY ──────────────────────────────────────────────────

    def test_unverified_install_gets_exactly_one_reinstall_then_the_honest_give_up(self):
        """THE churn pin: registry bumps but the exe stays stale -> ONE full
        delete-and-reinstall retry (2 installs, 1 uninstall -- never a third
        cycle), then the give-up whose note says the next run will ASK."""
        self.installed_script = [self._current("0.123.0"), self._current(),
                                 self._current(), self._current()]
        # The disk exe never catches up: stale before AND after both installs.
        self.exe_version_script = ["0.123.0", "0.123.0", "0.123.0"]

        self.assertFalse(LAUNCHER.desktop_flow("pat-token"))

        self.assertEqual(len(self.installs), 2, "exactly ONE retry install")
        self.assertEqual(self.uninstalls, [_VERSION], "the retry uninstalls exactly once")
        self.assertEqual(self.flags_written, [_VERSION])
        self.assertTrue(any("ONE retry: deleting the app completely and reinstalling it once more" in m
                            for m in self.oks))
        self.assertTrue(any("the next run will ASK whether to delete and reinstall" in m
                            for m in self.notes))
        self.assertTrue(any("which step failed: the registry reports" in m for m in self.warns))

    def test_verified_upgrade_never_reinstalls(self):
        """The healthy upgrade: one install, zero uninstalls, no repair flag."""
        self.installed_script = [self._current("0.123.0"), self._current()]
        self.exe_version_script = ["0.123.0", _VERSION]

        self.assertTrue(LAUNCHER.desktop_flow("pat-token"))

        self.assertEqual(len(self.installs), 1)
        self.assertEqual(self.uninstalls, [])
        self.assertEqual(self.flags_written, [])
        # twice: the verified install clears it, the launched engine match
        # clears it again (the pre-existing R63 double-clear).
        self.assertEqual(self.flags_cleared, 2)

    # ── THE OPT-IN REPAIR ─────────────────────────────────────────────────

    def test_repair_flag_on_a_normal_run_never_silently_uninstalls(self):
        """THE opt-in pin: no tty (mocked — hermetic even when the suite is
        run by hand from a real terminal), so the real _ask_repair_now
        answers None -- the honest warn says so, and NO uninstall ever runs
        (the engine-hybrid world: disk current, engine stale, re-flagged)."""
        LAUNCHER._read_repair_flag = lambda: "0.123.0"
        self.installed_script = [self._current()]
        self.exe_version_script = [_VERSION]
        self.engine_version = "0.123.0"  # the hybrid: disk current, engine stale

        with mock.patch.object(LAUNCHER.sys.stdin, "isatty", return_value=False):
            self.assertTrue(LAUNCHER.desktop_flow("pat-token"))

        self.assertEqual(self.uninstalls, [], "a normal run never silently churns")
        self.assertEqual(self.installs, [])
        self.assertTrue(any("cannot ask" in m and "pending repair stays flagged" in m
                            for m in self.warns))
        # The engine mismatch re-flags with the release version (the data
        # survives the pre-existing verified-current clear).
        self.assertEqual(self.flags_written, [_VERSION])
        self.assertTrue(any("the next run will ASK whether to delete and reinstall" in m
                            for m in self.oks))

    def test_approved_ask_runs_the_cycle_once(self):
        LAUNCHER._read_repair_flag = lambda: "0.123.0"
        self.installed_script = [self._current(), self._current(), self._current()]
        self.exe_version_script = [_VERSION, _VERSION, _VERSION]
        with mock.patch.object(LAUNCHER, "_ask_repair_now", return_value=True):
            self.assertTrue(LAUNCHER.desktop_flow("pat-token"))

        self.assertEqual(self.uninstalls, [_VERSION], "the approved repair uninstalls exactly once")
        self.assertEqual(len(self.installs), 1)
        self.assertTrue(any("you approved" in m for m in self.oks))

    def test_declined_ask_clears_the_flag_and_never_uninstalls(self):
        LAUNCHER._read_repair_flag = lambda: "0.123.0"
        self.installed_script = [self._current()]
        self.exe_version_script = [_VERSION]
        with mock.patch.object(LAUNCHER, "_ask_repair_now", return_value=False):
            self.assertTrue(LAUNCHER.desktop_flow("pat-token"))

        self.assertEqual(self.uninstalls, [])
        self.assertEqual(self.installs, [])
        self.assertGreaterEqual(self.flags_cleared, 1)
        self.assertTrue(any("the repair was declined for this run" in m for m in self.warns))

    def test_force_reinstall_skips_the_ask_entirely(self):
        """The explicit door: ACUTE.bat reinstall IS the approved ask."""
        LAUNCHER._read_repair_flag = lambda: "0.123.0"
        self.installed_script = [self._current(), self._current(), self._current()]
        self.exe_version_script = [_VERSION, _VERSION, _VERSION]
        with mock.patch.object(LAUNCHER, "_ask_repair_now", return_value=None) as recorder:
            self.assertTrue(LAUNCHER.desktop_flow("pat-token", force_reinstall=True))

        self.assertEqual(recorder.call_count, 0, "force_reinstall never asks")
        self.assertEqual(self.uninstalls, [_VERSION])
        self.assertEqual(len(self.installs), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

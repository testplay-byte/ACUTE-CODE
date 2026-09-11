#!/usr/bin/env python3
"""R90-B1 regression tests — the launcher's GitHub-token PATH.

The round-90 owner report: "Check for updates" in the app's Settings said
"the launcher's GitHub token is not saved on this machine" FOREVER — even
after the owner ran acute.bat and let it save the token. Root cause: the
LAUNCHER saved the PAT at  <kit-folder>/.acute/github.pat  while the APP's
sidecar (agent-core/src/routes/system.ts readLauncherGithubPat) reads
<user-home>/.acute/github.pat — a path mismatch, so the app could never
find a file the launcher had honestly saved.

These tests load the REAL launcher module (same import-safe pattern as
test_pick_latest_release.py — module level is constants + pure definitions
only) and pin the R90-B1 contract:
  · PAT_PATH is the USER-HOME location (exactly what the sidecar reads),
    with the old kit-relative spot kept only as LEGACY_PAT_PATH;
  · resolve_github_pat MIGRATES a legacy kit token into the home (read →
    write → delete, home wins if both exist, env-var runs still migrate);
  · a FAILED migration falls back to reading the legacy copy (a locked or
    unwritable home must never lock the owner out of their own token);
  · with nothing anywhere, the interactive prompt is still the last resort
    (pinned via the EOFError → _no_interactive_github_pat handoff).

Run (repo root):      python -m unittest discover -s launcher/tests -v
Run (anywhere):       python launcher/tests/test_github_pat.py
CI: wired into .github/workflows/ci.yml (the push gate) and release.yml's
launcher-kit quality gate via the same discovery command as R74's picker
tests.
"""
import getpass as _getpass_module
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

_LAUNCHER = Path(__file__).resolve().parents[1] / "acute_launcher.py"
_SPEC = importlib.util.spec_from_file_location("acute_launcher_pat_under_test", _LAUNCHER)
LAUNCHER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(LAUNCHER)

_PAT = "github_pat_r90b1_moving_day"


class _PromptReached(Exception):
    """Raised by the patched _no_interactive_github_pat — proves the token
    resolution really reached the first-run prompt (never silently None)."""


class GithubPatPathTests(unittest.TestCase):
    """The R90-B1 contract: home location, migration, fallback, prompt."""

    def setUp(self):
        # ── isolation: no env token, temp home + legacy paths, silent log ──
        # The environment is the FIRST source resolve_github_pat checks —
        # a developer machine that exports ACUTE_GITHUB_PAT would flip every
        # expectation here, so both keys are removed for the test's lifetime
        # (the same hermeticity rule the vitest r89-updates suite applies).
        self._saved_env = {}
        for key in ("ACUTE_GITHUB_PAT", "GITHUB_PAT"):
            self._saved_env[key] = os.environ.pop(key, None)

        # A temp "user home" and a temp "kit folder" — the real module-level
        # PAT_PATH / LEGACY_PAT_PATH are patched to point at them (the
        # functions read the module globals at call time, so patching works).
        self._tmp = tempfile.TemporaryDirectory(prefix="acute-r90b1-pat-")
        self.addCleanup(self._tmp.cleanup)
        self._home = Path(self._tmp.name) / "home"
        self._kit = Path(self._tmp.name) / "kit"
        self._home.mkdir()
        self._kit.mkdir()
        self._saved_paths = (LAUNCHER.PAT_PATH, LAUNCHER.LEGACY_PAT_PATH)
        LAUNCHER.PAT_PATH = self._home / ".acute" / "github.pat"
        LAUNCHER.LEGACY_PAT_PATH = self._kit / ".acute" / "github.pat"

        # The launcher's log() appends to the REAL kit-relative
        # launcher/.acute/launcher.log — recording instead keeps the repo's
        # working tree clean AND lets the tests assert what was logged.
        self._saved_log = LAUNCHER.log
        self.logged = []
        LAUNCHER.log = self.logged.append

        # Belt for every non-prompt test: the masked getpass must NEVER run
        # (it would read the developer's terminal or block CI's stdin).
        self._saved_getpass = _getpass_module.getpass
        _getpass_module.getpass = self._fail_prompt

        # Restore everything the tests patched — module attributes on the
        # loaded copy, the process env, and the shared getpass module.
        self.addCleanup(self._restore)

    def _restore(self):
        LAUNCHER.PAT_PATH, LAUNCHER.LEGACY_PAT_PATH = self._saved_paths
        LAUNCHER.log = self._saved_log
        _getpass_module.getpass = self._saved_getpass
        # The env keys are DELETED before restoring: a test that SETS
        # ACUTE_GITHUB_PAT (the env-wins case) must not leak it into the
        # next test — alphabetical order runs the env test before the
        # fallback/prompt tests, so only the original keys go back in.
        for key, value in self._saved_env.items():
            os.environ.pop(key, None)
            if value is not None:
                os.environ[key] = value

    def _fail_prompt(self, *args, **kwargs):
        raise AssertionError("resolve_github_pat reached the interactive prompt")

    def _plant(self, path, pat):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(pat + "\n", encoding="utf-8")

    # ── the location contract ─────────────────────────────────────────────

    def test_pat_path_is_the_user_home(self):
        """THE fix, pinned at the source: the launcher saves/reads the token
        at Path.home()/.acute/github.pat — exactly the path the app's sidecar
        reads (the pre-R90 kit-relative location is what the app could never
        find). LEGACY_PAT_PATH keeps the old kit-relative spot for the
        migration + fallback below. Asserted on the PRISTINE import-time
        constants (setUp's saved pair) — every other test works on the
        patched temp paths, this one pins what the module itself computes."""
        pat_path, legacy_path = self._saved_paths
        self.assertEqual(pat_path, Path.home() / ".acute" / "github.pat")
        self.assertEqual(legacy_path, LAUNCHER.LAUNCHER_DIR / ".acute" / "github.pat")
        self.assertNotEqual(pat_path, legacy_path)

    # ── the migration ─────────────────────────────────────────────────────

    def test_legacy_kit_token_migrates_into_the_home(self):
        """The owner's exact situation: a pre-R90 launcher already saved the
        token at <kit>/.acute/github.pat. The next launcher run must MOVE it
        into the user home (read → write → delete) so the app finally finds
        it — and resolve returns the migrated token."""
        self._plant(LAUNCHER.LEGACY_PAT_PATH, _PAT)
        self.assertFalse(LAUNCHER.PAT_PATH.is_file())  # home copy starts absent

        resolved = LAUNCHER.resolve_github_pat()

        self.assertEqual(resolved, _PAT)
        self.assertTrue(LAUNCHER.PAT_PATH.is_file())
        self.assertEqual(LAUNCHER.PAT_PATH.read_text(encoding="utf-8").strip(), _PAT)
        self.assertFalse(LAUNCHER.LEGACY_PAT_PATH.is_file())  # moved, not copied
        self.assertTrue(any("migrated" in line for line in self.logged))

    def test_existing_home_token_wins_no_migration(self):
        """When BOTH copies exist (e.g. the owner re-saved the token after
        the migration already ran once, or planted a fresh one manually),
        the HOME copy is the answer and the legacy file is left alone —
        a stale kit copy must never overwrite a newer home token."""
        self._plant(LAUNCHER.PAT_PATH, "github_pat_home_copy")
        self._plant(LAUNCHER.LEGACY_PAT_PATH, "github_pat_legacy_copy")

        self.assertEqual(LAUNCHER.resolve_github_pat(), "github_pat_home_copy")
        self.assertEqual(
            LAUNCHER.PAT_PATH.read_text(encoding="utf-8").strip(), "github_pat_home_copy"
        )
        self.assertTrue(LAUNCHER.LEGACY_PAT_PATH.is_file())  # untouched

    def test_env_token_wins_but_migration_still_runs(self):
        """The env var short-circuits the RETURN value, but the migration
        still runs first: a launcher started via ACUTE_GITHUB_PAT must also
        carry the owner's saved file over, so an app started WITHOUT the
        launcher (Start Menu — no env) still finds the home copy."""
        os.environ["ACUTE_GITHUB_PAT"] = "github_pat_from_env"
        self._plant(LAUNCHER.LEGACY_PAT_PATH, _PAT)

        self.assertEqual(LAUNCHER.resolve_github_pat(), "github_pat_from_env")
        # The side effect that makes the app work env-independently:
        self.assertTrue(LAUNCHER.PAT_PATH.is_file())
        self.assertEqual(LAUNCHER.PAT_PATH.read_text(encoding="utf-8").strip(), _PAT)
        self.assertFalse(LAUNCHER.LEGACY_PAT_PATH.is_file())

    # ── the fallback ──────────────────────────────────────────────────────

    def test_failed_migration_falls_back_to_the_legacy_copy(self):
        """A home that cannot be written (locked, read-only, or a `.acute`
        placeholder FILE squatting on the directory name — what this test
        plants) must never lock the owner out: the migration fails loudly,
        the legacy kit copy stays on disk, and resolve still returns it."""
        # `home/.acute` exists as a regular FILE → the migration's
        # mkdir(parents=True, exist_ok=True) raises FileExistsError
        # (exist_ok only tolerates an existing DIRECTORY).
        (self._home / ".acute").write_text("not a directory", encoding="utf-8")
        self._plant(LAUNCHER.LEGACY_PAT_PATH, _PAT)

        self.assertEqual(LAUNCHER.resolve_github_pat(), _PAT)
        # The legacy copy survived the failed move (delete happens only
        # after the home write succeeded).
        self.assertTrue(LAUNCHER.LEGACY_PAT_PATH.is_file())
        self.assertTrue(any("migration failed" in line for line in self.logged))

    # ── the last resort ────────────────────────────────────────────────────

    def test_no_token_anywhere_reaches_the_first_run_prompt(self):
        """A genuinely fresh machine (no env, no home file, no legacy file)
        still ends at the interactive first-run prompt — pinned through the
        EOFError → _no_interactive_github_pat handoff a non-interactive
        shell takes (the test patches getpass to EOF and the handler to a
        loud sentinel, so neither a real terminal read nor a silent
        SystemExit can mask the path being taken)."""
        def _eof(*args, **kwargs):
            raise EOFError()

        _getpass_module.getpass = _eof
        self._saved_no_interactive = LAUNCHER._no_interactive_github_pat

        def _sentinel():
            raise _PromptReached()

        LAUNCHER._no_interactive_github_pat = _sentinel
        try:
            with self.assertRaises(_PromptReached):
                LAUNCHER.resolve_github_pat()
        finally:
            LAUNCHER._no_interactive_github_pat = self._saved_no_interactive


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""R74 regression tests — the launcher's release picker.

The round-74 owner report: "the installed desktop app version was 0.67.0 —
the application apparently did not update." Root cause: GitHub's /releases
list sorts never-published DRAFTS above every published release, and the
old first-match walk in _desktop_latest_release returned draft v0.67.0 as
"latest" — so an installed 0.67.0 looked current while v0.73.0 was live.

These tests load the REAL launcher module (its module level is constants
only — import-safe by construction) and pin _pick_latest_release's
contract: max version, never list order; drafts first-class; published
wins a same-version tie; None when nothing matches; the chosen asset's id
and digest pass through untouched (the sha256 install verification and
the API download both depend on them).

Run (repo root):      python -m unittest discover -s launcher/tests -v
Run (anywhere):       python launcher/tests/test_pick_latest_release.py
CI: wired into .github/workflows/ci.yml (the push gate) and release.yml's
launcher-kit quality gate (the release gate).
"""
import importlib.util
import unittest
from pathlib import Path

_LAUNCHER = Path(__file__).resolve().parents[1] / "acute_launcher.py"
_SPEC = importlib.util.spec_from_file_location("acute_launcher_under_test", _LAUNCHER)
LAUNCHER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(LAUNCHER)

_IDS = iter(range(1000, 9999))
_SHA = "sha256:" + "a" * 64


def _release(tag, version, *, draft=False, created="2026-09-07T00:00:00Z",
             digest=_SHA, with_installer=True):
    """A minimal /releases list entry — only the fields the picker reads."""
    if with_installer:
        assets = [{
            "name": f"ACUTE-CODE_{version}_x64-setup.exe",
            "id": next(_IDS),
            "digest": digest,
        }]
    else:
        assets = [{
            "name": f"acute-launcher-kit-v{version}.zip",
            "id": next(_IDS),
            "digest": digest,
        }]
    return {"tag_name": tag, "draft": draft, "created_at": created, "assets": assets}


class PickLatestReleaseTests(unittest.TestCase):
    """The contract: MAX VERSION, never list order."""

    def test_round74_owner_freeze_exact_scenario(self):
        """THE bug, exactly as the API served it on 2026-09-07: the five
        never-published round-63..67 drafts sit ABOVE every published
        release. The old first-match walk returned 0.67.0; the picker must
        return 0.73.0 — published, tag named, id and digest of THAT asset
        (the download and the sha256 install verification depend on them)."""
        top = _release("v0.73.0", "0.73.0", created="2026-09-07T11:00:00Z",
                       digest="sha256:" + "c" * 64)
        releases = [
            _release("v0.67.0", "0.67.0", draft=True, created="2026-09-05T10:00:00Z"),
            _release("v0.66.0", "0.66.0", draft=True, created="2026-09-05T09:00:00Z"),
            _release("v0.65.0", "0.65.0", draft=True, created="2026-09-03T09:00:00Z"),
            _release("v0.64.0", "0.64.0", draft=True, created="2026-09-02T15:00:00Z"),
            _release("v0.63.0", "0.63.0", draft=True, created="2026-09-02T09:00:00Z"),
            top,
            _release("v0.72.0", "0.72.0", created="2026-09-07T10:00:00Z"),
            _release("v0.71.0", "0.71.0", created="2026-09-07T09:00:00Z"),
            _release("v0.70.0", "0.70.0", created="2026-09-06T10:00:00Z"),
            _release("v0.69.0", "0.69.0", created="2026-09-05T09:00:00Z"),
            _release("v0.60.0", "0.60.0", created="2026-09-01T09:00:00Z"),
        ]
        picked = LAUNCHER._pick_latest_release(releases)
        self.assertIsNotNone(picked)
        version, asset_id, digest, info = picked
        self.assertEqual(version, "0.73.0")
        self.assertEqual(asset_id, top["assets"][0]["id"])
        self.assertEqual(digest, "sha256:" + "c" * 64)
        self.assertEqual(info["tag"], "v0.73.0")
        self.assertFalse(info["draft"])

    def test_newest_last_in_list_still_wins(self):
        """Order immunity, the other direction: the newest entry at the END
        of the page (a stale-first cache, a re-sorted API response) is
        still picked."""
        releases = [
            _release("v0.60.0", "0.60.0"),
            _release("v0.71.0", "0.71.0"),
            _release("v0.73.0", "0.73.0"),
        ]
        self.assertEqual(LAUNCHER._pick_latest_release(releases)[0], "0.73.0")

    def test_numeric_not_lexicographic(self):
        """'0.9.0' sorts above '0.10.0' as a STRING — the picker must
        compare numerically (the whole reason _version_tuple exists)."""
        releases = [
            _release("v0.9.0", "0.9.0"),
            _release("v0.10.0", "0.10.0"),
        ]
        self.assertEqual(LAUNCHER._pick_latest_release(releases)[0], "0.10.0")

    def test_major_beats_minor(self):
        releases = [
            _release("v0.99.99", "0.99.99"),
            _release("v1.0.0", "1.0.0"),
        ]
        self.assertEqual(LAUNCHER._pick_latest_release(releases)[0], "1.0.0")

    def test_all_drafts_era_still_updates(self):
        """The round-63..67 all-draft era: drafts are first-class (the
        owner's PAT sees them by design since R51) — the newest DRAFT is
        picked, so updates kept flowing within that era."""
        releases = [
            _release("v0.63.0", "0.63.0", draft=True),
            _release("v0.65.0", "0.65.0", draft=True),
            _release("v0.64.0", "0.64.0", draft=True),
        ]
        picked = LAUNCHER._pick_latest_release(releases)
        self.assertEqual(picked[0], "0.65.0")
        self.assertTrue(picked[3]["draft"])

    def test_same_version_tie_prefers_published(self):
        """A draft and a published release of the SAME version coexisting:
        same bytes, but the published one is what every token can see —
        regardless of which appears first in the list."""
        draft = _release("v0.74.0", "0.74.0", draft=True)
        published = _release("v0.74.0", "0.74.0")
        for order in ([draft, published], [published, draft]):
            picked = LAUNCHER._pick_latest_release(order)
            self.assertEqual(picked[0], "0.74.0")
            self.assertFalse(
                picked[3]["draft"],
                "the published entry must win the tie regardless of list order",
            )
            self.assertEqual(picked[1], published["assets"][0]["id"])

    def test_no_installer_assets_returns_none(self):
        """Entries whose assets are only launcher-kit zips (no setup.exe)
        are not candidates — None, never an error (the caller falls back to
        the dev flow by design)."""
        releases = [_release("v0.73.0", "0.73.0", with_installer=False)]
        self.assertIsNone(LAUNCHER._pick_latest_release(releases))

    def test_empty_list_returns_none(self):
        self.assertIsNone(LAUNCHER._pick_latest_release([]))

    def test_malformed_entries_do_not_crash(self):
        """The API is external: non-dict entries, assets=None, an asset
        without an id, non-dict assets — all skipped, never raised."""
        releases = [
            None,
            "v0.99.0",
            {"tag_name": "v0.98.0", "assets": None},
            {"tag_name": "v0.97.0", "assets": [
                {"name": "ACUTE-CODE_0.97.0_x64-setup.exe", "digest": "sha256:x"}]},
            {"tag_name": "v0.96.0", "assets": [
                None, 42, {"name": "ACUTE-CODE_0.96.0_x64-setup.exe", "id": 77}]},
        ]
        picked = LAUNCHER._pick_latest_release(releases)
        self.assertEqual(picked[0], "0.96.0")
        self.assertEqual(picked[1], 77)

    def test_non_matching_asset_names_ignored(self):
        """Only the tauri NSIS contract counts: arm64, two-component and
        suffixed names never match — the x64 one in the SAME release does."""
        releases = [{
            "tag_name": "v0.99.0",
            "draft": False,
            "created_at": "2026-09-07T00:00:00Z",
            "assets": [
                {"name": "ACUTE-CODE_0.99.0_arm64-setup.exe", "id": 1},
                {"name": "ACUTE-CODE_0.99_x64-setup.exe", "id": 2},
                {"name": "ACUTE-CODE_0.99.0_x64-setup(1).exe", "id": 3},
                {"name": "acute-launcher-kit-v0.99.0.zip", "id": 4},
                {"name": "ACUTE-CODE_0.98.0_x64-setup.exe", "id": 5},
            ],
        }]
        picked = LAUNCHER._pick_latest_release(releases)
        self.assertEqual((picked[0], picked[1]), ("0.98.0", 5))


if __name__ == "__main__":
    unittest.main(verbosity=2)

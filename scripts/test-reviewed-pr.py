"""Exercise the actual verifier with GitHub API/download failures and stale proof."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SHA = "a" * 40
MOCK = r'''
import json, os, pathlib, sys
scenario = os.environ["SCENARIO"]
args = sys.argv[1:]
if scenario == "api-error":
    sys.exit(1)
if args[0] == "run":
    if scenario in ("missing-artifact", "expired-artifact"):
        sys.exit(1)
    destination = pathlib.Path(args[args.index("--dir") + 1])
    tree = "d" * 40 if scenario == "mismatched-tree" else "c" * 40
    (destination / "tree").write_text(tree + "\n")
elif "/pulls" in args[1]:
    pr = {"number": 42, "merged_at": "2026-09-01", "base": {"ref": "main"},
          "merge_commit_sha": "a" * 40, "head": {"sha": "b" * 40,
          "repo": {"full_name": "example/repo"}}}
    if scenario == "unmerged-pr": pr["merged_at"] = None
    if scenario == "wrong-merge": pr["merge_commit_sha"] = "e" * 40
    if scenario == "wrong-base": pr["base"]["ref"] = "other"
    print(json.dumps([] if scenario == "no-pr" else [pr]))
elif "git/commits" in args[1]:
    print("" if scenario == "invalid-tree" else "c" * 40)
else:
    run = {"id": 7, "event": "pull_request", "head_sha": "b" * 40,
           "head_repository": {"full_name": "example/repo"}, "status": "completed",
           "conclusion": "success", "path": ".github/workflows/ci.yml"}
    if scenario == "failed-run": run["conclusion"] = "failure"
    if scenario == "cancelled-run": run["conclusion"] = "cancelled"
    if scenario == "running-run": run["status"] = "in_progress"
    if scenario == "wrong-head": run["head_sha"] = "e" * 40
    if scenario == "wrong-repo": run["head_repository"]["full_name"] = "other/repo"
    if scenario == "wrong-workflow": run["path"] = ".github/workflows/other.yml"
    if scenario == "push-run": run["event"] = "push"
    print(json.dumps({"workflow_runs": [] if scenario == "no-run" else [run]}))
'''


class ReviewedTreeTest(unittest.TestCase):
    def verify(self, scenario):
        with tempfile.TemporaryDirectory() as directory:
            gh = Path(directory) / "gh"
            gh.write_text(f"#!{sys.executable}\n" + MOCK)
            gh.chmod(0o755)
            environment = dict(os.environ, SCENARIO=scenario, GITHUB_REPOSITORY="example/repo")
            environment["PATH"] = directory + os.pathsep + environment["PATH"]
            return subprocess.run(
                ["bash", str(Path(__file__).with_name("reviewed-pr.sh")), SHA],
                env=environment, capture_output=True, text=True, check=False,
            )

    def test_exact_tree_from_successful_pr(self):
        result = self.verify("matching-tree")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("matches the tested tree", result.stdout)

    def test_unproven_tree_requires_validation(self):
        for scenario in (
            "api-error", "missing-artifact", "expired-artifact", "mismatched-tree",
            "no-pr", "unmerged-pr", "wrong-merge", "wrong-base", "invalid-tree",
            "no-run", "failed-run", "cancelled-run", "running-run", "wrong-head",
            "wrong-repo", "wrong-workflow", "push-run",
        ):
            with self.subTest(scenario=scenario):
                self.assertNotEqual(self.verify(scenario).returncode, 0)


if __name__ == "__main__":
    unittest.main()

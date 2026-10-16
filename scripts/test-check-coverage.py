"""Exercise the production line coverage gate on a throwaway workspace."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("check_coverage", Path(__file__).with_name("check-coverage.py"))
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

SOURCE = """pub fn shipped() -> &'static str {
    "{ not a block"
}

#[cfg(test)]
fn helper() -> char { '{' }

#[cfg(test)]
mod tests {
    #[test]
    fn braces_in_literals() {
        let _ = r#"}}} "quoted" "#;
        let _ = "\\"}";
        // }
        /* } */
    }
}

pub fn also_shipped() {}
"""


class TestLines(unittest.TestCase):
    def test_excludes_cfg_test_items_but_not_code_after_them(self):
        excluded = gate.test_lines(SOURCE)
        self.assertEqual(sorted(excluded), [5, 6, *range(8, 18)])
        self.assertNotIn(19, excluded)

    def test_handles_declarations_and_unterminated_input(self):
        self.assertEqual(gate.test_lines("#[cfg(test)]\nmod tests;\nfn x() {}\n"), {1, 2})
        self.assertEqual(gate.test_lines('#[cfg(test)]\nfn broken() { "\n'), {1, 2, 3})

    def test_compresses_ranges(self):
        self.assertEqual(gate.compress([1, 2, 3, 5, 7, 8]), "1-3, 5, 7-8")


class Check(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        files = {
            "crates/a/src/lib.rs": SOURCE,
            "crates/a/src/decls.rs": "pub mod x;\npub use x::Y;\n",
            "crates/a/src/tests.rs": "fn t() {}\n",
            "crates/a/src/main.rs": "fn main() {}\n",
            "crates/a/tests/it.rs": "fn it() {}\n",
        }
        for path, text in files.items():
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text(text)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)

    def lcov(self, records):
        path = self.root / "lcov.info"
        lines = []
        for source, hits in records.items():
            lines.append(f"SF:/elsewhere/checkout/{source}")
            lines += [f"DA:{n},{c}" for n, c in hits.items()]
            lines.append("end_of_record")
        path.write_text("\n".join(lines) + "\n")
        return gate.parse_lcov(path, self.root)

    def test_passes_when_every_production_line_ran(self):
        report = self.lcov({"crates/a/src/lib.rs": {1: 1, 2: 1, 3: 1, 11: 0, 19: 1}, "crates/a/src/main.rs": {1: 1}})
        covered, total, problems = gate.check(report, {}, self.root)
        self.assertEqual((covered, total, problems), (5, 5, []))

    def test_reports_missed_lines_missing_files_and_unexplained_exclusions(self):
        report = self.lcov({"crates/a/src/lib.rs": {1: 1, 2: 0, 3: 0, 19: 0}})
        scope = {"exclude": ["crates/a/src/other.rs"]}
        _, _, problems = gate.check(report, scope, self.root)
        self.assertIn("crates/a/src/lib.rs: uncovered lines 2-3, 19", problems)
        self.assertIn("crates/a/src/main.rs: not in the coverage report", problems)
        self.assertIn("exclusion 'crates/a/src/other.rs' has no reason", problems)
        self.assertFalse(any("decls.rs" in p or "tests" in p for p in problems), problems)

    def test_exclusions_with_reasons_are_skipped(self):
        report = self.lcov({"crates/a/src/lib.rs": {1: 1}})
        scope = {"exclude": ["crates/a/src/main.rs"], "exclusionReasons": {"crates/a/src/main.rs": "glue"}}
        self.assertEqual(gate.check(report, scope, self.root)[2], [])

    def test_main_exit_codes(self):
        report = self.root / "lcov.info"
        report.write_text("SF:crates/a/src/lib.rs\nDA:1,0\nend_of_record\nSF:/outside\nDA:1,0\n")
        scope = self.root / "scope.json"
        scope.write_text(json.dumps({"exclude": ["crates/a/src/main.rs"], "exclusionReasons": {"crates/a/src/main.rs": "x"}}))
        run = lambda *args: subprocess.run([sys.executable, str(Path(__file__).with_name("check-coverage.py")), *args],
                                           cwd=self.root, capture_output=True, text=True)
        failed = run(str(report), str(scope))
        self.assertEqual(failed.returncode, 1, failed.stdout)
        self.assertIn("uncovered lines 1", failed.stdout)
        self.assertEqual(run().returncode, 2)


if __name__ == "__main__":
    unittest.main()

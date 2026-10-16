"""Fail unless every production line in the workspace is covered.

Usage: python3 scripts/check-coverage.py <lcov.info> [coverage-scope.json]

Production code is every tracked `crates/*/src/**/*.rs` file minus test code:
files named `tests.rs` or `testing.rs`, and items marked `#[cfg(test)]` (test
modules and helpers). `sol!` blocks are skipped too: they only declare Solidity
types, and the compile-time `_type_assertion` functions alloy generates for them
never run. Files listed under `exclude` in the scope file are
skipped; each needs a reason under `exclusionReasons`. A tracked source file
with functions that never appears in the report counts as uncovered.
"""
import fnmatch
import json
from pathlib import Path
import re
import subprocess
import sys

CFG_TEST = re.compile(r"^\s*#\[cfg\(test\)\]\s*$")
SOL_BLOCK = re.compile(r"^\s*(?:alloy_sol_types::|alloy::sol_types::)?sol!\s*\{")


def skip_literal(text, i):
    """Return the index just past a string/char literal starting at text[i], or i."""
    raw = re.match(r'(b?r)(#*)"', text[i:])
    if raw:
        end = text.find('"' + raw.group(2), i + raw.end())
        return len(text) if end < 0 else end + 1 + len(raw.group(2))
    if text[i] == '"' or text.startswith('b"', i):
        j = i + (2 if text[i] == "b" else 1)
        while j < len(text):
            if text[j] == "\\":
                j += 2
                continue
            if text[j] == '"':
                return j + 1
            j += 1
        return len(text)
    char = re.match(r"b?'(\\.|[^\\'])'", text[i:])
    if char:
        return i + char.end()
    return i


def item_end(text, start):
    """Index just past the item that starts at `start`: its `;` or matching `}`."""
    depth, i = 0, start
    while i < len(text):
        if text.startswith("//", i):
            i = text.find("\n", i)
            i = len(text) if i < 0 else i
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = len(text) if end < 0 else end + 2
            continue
        j = skip_literal(text, i)
        if j != i:
            i = j
            continue
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        elif c == ";" and depth == 0:
            return i + 1
        i += 1
    return len(text)


def test_lines(source):
    """1-based line numbers that belong to `#[cfg(test)]` items or `sol!` blocks."""
    lines = source.split("\n")
    offsets, total = [], 0
    for line in lines:
        offsets.append(total)
        total += len(line) + 1
    excluded = set()
    for index, line in enumerate(lines):
        if index + 1 in excluded:
            continue
        if CFG_TEST.match(line):
            end = item_end(source, offsets[index] + len(line))
        elif SOL_BLOCK.match(line):
            end = item_end(source, offsets[index] + line.index("{"))
        else:
            continue
        last = source.count("\n", 0, end) + 1
        excluded.update(range(index + 1, last + 1))
    return excluded


def is_test_file(path):
    return Path(path).name in ("tests.rs", "testing.rs") or "/tests/" in path or "/benches/" in path


def tracked_sources(root):
    out = subprocess.run(["git", "ls-files", "-z", "crates"], cwd=root, check=True, capture_output=True).stdout
    return sorted(p for p in out.decode().split("\0") if re.match(r"crates/[^/]+/src/.*\.rs$", p))


def parse_lcov(path, root):
    hits, current = {}, None
    for line in Path(path).read_text().splitlines():
        if line.startswith("SF:"):
            source = Path(line[3:])
            try:
                current = source.resolve().relative_to(Path(root).resolve()).as_posix()
            except ValueError:
                # Reports from another checkout (CI artifacts) still map by workspace path.
                text = source.as_posix()
                current = text[text.index("/crates/") + 1 :] if "/crates/" in text else None
            if current is not None:
                hits.setdefault(current, {})
        elif line.startswith("DA:") and current is not None:
            number, count = line[3:].split(",")[:2]
            hits[current][int(number)] = hits[current].get(int(number), 0) + int(count)
    return hits


def check(lcov, scope, root):
    excludes = scope.get("exclude", [])
    reasons = scope.get("exclusionReasons", {})
    problems = [f"exclusion {p!r} has no reason" for p in excludes if p not in reasons]
    covered = total = 0
    for path in tracked_sources(root):
        if is_test_file(path) or any(fnmatch.fnmatch(path, p) for p in excludes):
            continue
        source = (Path(root) / path).read_text()
        skipped = test_lines(source)
        report = lcov.get(path)
        if report is None:
            # Files of only `mod`/`use`/type declarations or trait method
            # signatures (`fn f();`) have no executable lines.
            code = "\n".join(l for n, l in enumerate(source.split("\n"), 1) if n not in skipped)
            if re.search(r"\bfn\b[^;{]*\{", code):
                problems.append(f"{path}: not in the coverage report")
            continue
        lines = {n: c for n, c in report.items() if n not in skipped}
        missed = sorted(n for n, c in lines.items() if c == 0)
        total += len(lines)
        covered += len(lines) - len(missed)
        if missed:
            problems.append(f"{path}: uncovered lines {compress(missed)}")
    return covered, total, problems


def compress(numbers):
    ranges, start = [], None
    for n in numbers + [None]:
        if start is None:
            start = prev = n
        elif n is not None and n == prev + 1:
            prev = n
        else:
            ranges.append(f"{start}" if start == prev else f"{start}-{prev}")
            start = prev = n
    return ", ".join(ranges)


def main(argv):
    if len(argv) not in (2, 3):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    root = Path.cwd()
    scope = json.loads(Path(argv[2]).read_text()) if len(argv) == 3 else {}
    covered, total, problems = check(parse_lcov(argv[1], root), scope, root)
    percent = 100.0 if total == 0 else 100.0 * covered / total
    print(f"Production line coverage: {covered}/{total} ({percent:.2f}%)")
    for problem in problems:
        print(f"  {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

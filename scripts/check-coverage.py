"""Fail closed on missing source reports or weighted line coverage below 95%."""
import argparse
import fnmatch
import json
from pathlib import Path
import subprocess
import sys

THRESHOLD = 95


def check(config, reports, root):
    def included(path):
        return any(path == prefix or path.startswith(prefix.rstrip('/') + '/') or prefix == '.'
                   for prefix in config['roots']) and not any(
                       fnmatch.fnmatch(path, pattern) for pattern in config.get('exclude', []))

    sources = {path for path in subprocess.check_output(
        ['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
        if path and Path(path).suffix in config['extensions'] and included(path)}
    if not sources:
        raise ValueError('No source files matched the coverage scope')
    lines = {}
    seen = set()
    for report in reports:
        current = None
        report_lines = 0
        for entry in Path(report).read_text().splitlines():
            if entry.startswith('SF:'):
                path = Path(entry[3:])
                if not path.is_absolute():
                    path = root / config.get('reportBase', '.') / path
                try:
                    name = path.resolve().relative_to(root.resolve()).as_posix()
                except ValueError:
                    name = ''
                current = name if name in sources else None
                if current:
                    seen.add(current)
            elif entry.startswith('DA:') and current:
                fields = entry[3:].split(',')
                number, hits = int(fields[0]), int(fields[1])
                if number <= 0 or hits < 0:
                    raise ValueError('Invalid LCOV line data')
                report_lines += 1
                key = (current, number)
                lines[key] = lines.get(key, False) or hits > 0
            elif entry == 'end_of_record':
                current = None
        if not report_lines:
            raise ValueError(f'No scoped line data in {report}')
    if not lines:
        raise ValueError('No instrumented source lines in coverage reports')
    missing = sorted(sources - seen)
    covered = sum(lines.values())
    total = len(lines)
    passed = not missing and covered * 100 >= THRESHOLD * total
    result = {'threshold': THRESHOLD, 'covered': covered, 'total': total,
              'percent': round(covered * 100 / total, 2), 'missing': missing, 'passed': passed}
    print(json.dumps(result, indent=2))
    if missing:
        print('Coverage is incomplete: scoped source files are absent from LCOV.', file=sys.stderr)
    return passed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    parser.add_argument('reports', nargs='+')
    args = parser.parse_args()
    root = Path.cwd()
    try:
        return 0 if check(json.loads(Path(args.config).read_text()), args.reports, root) else 1
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'Coverage gate failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

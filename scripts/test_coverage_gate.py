import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('coverage_gate', Path(__file__).with_name('check-coverage.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class CoverageGateTests(unittest.TestCase):
    def test_threshold_missing_reports_and_merge(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'src').mkdir()
            (root / 'src/a.ts').write_text('synthetic\n' * 100)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            config = {'roots': ['src'], 'extensions': ['.ts']}
            def report(name, hits):
                path = root / name
                path.write_text('SF:src/a.ts\n' + ''.join(f'DA:{n},{int(n in hits)}\n' for n in range(1, 101)) + 'end_of_record\n')
                return path
            low = report('low.info', range(1, 95))
            exact = report('exact.info', range(1, 96))
            extra = report('extra.info', [95])
            self.assertFalse(gate.check(config, [low], root))
            self.assertTrue(gate.check(config, [exact], root))
            self.assertTrue(gate.check(config, [low, extra], root))
            bad = root / 'bad.info'
            bad.write_text('SF:src/a.ts\nDA:1,-1\nend_of_record\n')
            with self.assertRaises(ValueError):
                gate.check(config, [bad], root)
            # A tiny fully-covered file must not inflate the large file's result.
            (root / 'src/tiny.ts').write_text('synthetic')
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            weighted = root / 'weighted.info'
            weighted.write_text(low.read_text() + 'SF:src/tiny.ts\nDA:1,1\nend_of_record\n')
            self.assertFalse(gate.check(config, [weighted], root))
            config['exclude'] = ['src/tiny.ts']
            with self.assertRaises(OSError):
                gate.check(config, [root / 'absent'], root)
            empty = root / 'empty.info'
            empty.write_text('')
            with self.assertRaises(ValueError):
                gate.check(config, [exact, empty], root)
            (root / 'src/missing.ts').write_text('synthetic')
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            self.assertFalse(gate.check(config, [exact], root))
            config['exclude'] = ['src/tiny.ts', 'src/missing.ts']
            self.assertTrue(gate.check(config, [exact], root))


if __name__ == '__main__':
    unittest.main()

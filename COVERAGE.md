# Coverage gate

CI requires **85% weighted line coverage** across the handwritten source scope in
`coverage-scope.json`. LCOV line hits are merged by source path and line number;
per-file percentages are not averaged. Bot merges both supported contract versions.

Missing, empty, malformed reports and scoped files absent from LCOV fail the gate.
An unloaded file therefore cannot silently disappear from the coverage requirement.
Generated clients, declarations, tests and fixtures are excluded explicitly; runtime
files must not be excluded merely to make the gate pass. Pure type-only modules
without reportable lines may require a reviewed explicit scope exclusion.

Reports are uploaded even when the gate fails. Existing below-threshold suites are
expected to fail until behavioral tests and instrumentation cover the scoped code.
This change adds enforcement, not tests to bring the entire codebase to 85%.

Run the same test coverage command as CI, then:

```sh
python3 scripts/check-coverage.py coverage-scope.json coverage/lcov.info
```

Explicit file exclusions also cover inspected type-only modules and re-export-only
barrels, which have no reportable implementation lines. Schema definitions and
serialization functions remain in scope.

# Coverage gate

CI requires **85% weighted line coverage** across the unit-testable API and data
services in `coverage-scope.json`. LCOV line hits are merged by source path and
line number; per-file percentages are not averaged.

Missing, empty, malformed reports and scoped files absent from LCOV fail the gate.
An unloaded file therefore cannot silently disappear from the coverage requirement.
Generated clients, declarations, tests and fixtures are excluded explicitly. The
scope keeps API handlers, persistence, oracle processing and transaction signing
under the unit-test gate; deployment entrypoints and provider-specific runners
are covered by their integration checks.

Reports are uploaded even when the gate fails. Changes to the scoped services must
include behavioral tests that keep the weighted result at or above 85%.

Run the same test coverage command as CI, then:

```sh
python3 scripts/check-coverage.py coverage-scope.json coverage/lcov.info
```

The explicit exclusions cover type-only contracts and transport wiring that cannot
produce meaningful unit-test line data; request validation and serialization
behavior remain in scope.

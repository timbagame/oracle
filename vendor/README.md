# Protocol release candidate

This archive is the `@timbagame/protocol` 0.8.0 package built from the sibling
protocol repository. It makes the shared-logic migration installable before the
registry release, including in isolated CI checkouts.

After publishing protocol v0.8.0, change the dependency to registry version
`0.8.0`, regenerate `bun.lock`, remove this archive, and rerun the repository's
checks. Regenerate the archive with `bun run build` and `bun pm pack` in protocol
if its implementation changes before release.

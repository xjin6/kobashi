# Repository instructions

Read [CLAUDE.md](CLAUDE.md) before changing or running Kobashi. Its live-process,
configuration ownership, and build instructions apply to all coding agents.
Never stop or restart the user's running Kobashi process; it may carry this chat.

## Keep the feature ledger current

[FEATURE_UPDATES.md](FEATURE_UPDATES.md) is the shared capability ledger for
Kobashi and downstream TokenX catch-up work. Read it before implementing a change.

For every feature, user-visible fix, compatibility change, UI/layout adjustment,
or packaging/lifecycle update, update the ledger in the same change:

- Add a dated entry describing the trigger and resulting behavior, with the
  relevant feature IDs, source files, validation actually performed, and limits.
- Update the current capability baseline when behavior changes. Record removals
  and replacements explicitly so downstream work does not copy obsolete behavior.
- Distinguish source changes, tested behavior, built artifacts, and released
  versions. Do not call an unbuilt/unreleased change shipped.
- State what TokenX should compare or implement; do not assume its current state
  unless its source was checked. Keep existing history and stable feature IDs.

Documentation-only maintenance can update an existing entry instead of creating
a new feature. Do not record secrets, account identifiers, or private local paths.

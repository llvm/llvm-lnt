// Drizzle schema for the v5 database.
//
// This holds only the *global* tables -- the ones that exist once per instance rather than once per
// test suite. Per-suite tables are created dynamically by the application when a suite is registered
// through the API, so they are deliberately not modelled here and never appear in a migration.
//
// The app shell has no tables yet; the first ones land with the data-model slice.

export {}

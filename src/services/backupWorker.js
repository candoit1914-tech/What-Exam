'use strict';

/**
 * The restore half of services/backup.js, run as its OWN process at the very
 * top of server.js — before `require('./routes/api')` opens (and, on a fresh
 * container, creates) the database file. CommonJS has no top-level await, so
 * the only way to make "download the backup" finish before "open the DB" is to
 * block the parent on a child that is allowed to await.
 *
 * Prints exactly ONE line of JSON — the runRestore outcome — to stdout; all
 * human-readable logging is the parent's job. Never loads an app module that
 * opens the database, so nothing here can race the real handle.
 */

const { runRestore } = require('./backup');

runRestore()
  .then((outcome) => {
    process.stdout.write(JSON.stringify(outcome));
    process.exit(0);
  })
  .catch((err) => {
    process.stdout.write(JSON.stringify({
      status: 'error',
      error: String((err && err.message) || err),
    }));
    process.exit(0); // the parent decides how loud this is; don't stack traces
  });

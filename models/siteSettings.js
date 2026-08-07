const { sql, withRetry } = require('../utils/db_connect');

// Generic key/value site settings (e.g. homepage_gallery_tag).

// Reads homepage_gallery_tag on every homepage load, so it gets the same retry as the
// rest of that page — see withRetry in utils/db_connect.js. (A failure here is already
// non-fatal: fixture_get_summary falls back to the default tag.)
exports.get = async function(key, done){
  try {
    const rows = await withRetry(() => sql`SELECT value FROM site_setting WHERE key = ${key}`);
    done(null, rows[0] ? rows[0].value : undefined);
  } catch (err) { done(err); }
}

exports.getAll = async function(done){
  try {
    const rows = await sql`SELECT key, value FROM site_setting ORDER BY key`;
    done(null, rows);
  } catch (err) { done(err); }
}

exports.set = async function(key, value, done){
  try {
    const rows = await sql`
      INSERT INTO site_setting (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      RETURNING *`;
    done(null, rows[0]);
  } catch (err) { done(err); }
}

// auth_account_notice (migrations/auth-account-notice.sql): the monthly login cull's record
// of warnings sent and logins kept. See controllers/authCullController.js.
const crypto = require('crypto');
const { sql } = require('../utils/db_connect');

const hash = token => crypto.createHash('sha256').update(String(token)).digest();

exports.getAll = async function () {
  const rows = await sql`SELECT user_id, notified_at, kept_at FROM auth_account_notice`;
  return new Map(rows.map(r => [r.user_id, r]));
};

// A new warning: a new keep token, and any earlier keep forgotten (it belongs to an
// earlier year, or the warning would not be going out).
exports.recordNotice = async function (userId, token) {
  await sql`
    INSERT INTO auth_account_notice (user_id, notified_at, keep_token_hash, kept_at)
    VALUES (${userId}, now(), ${hash(token)}, NULL)
    ON CONFLICT (user_id) DO UPDATE
      SET notified_at = now(), keep_token_hash = EXCLUDED.keep_token_hash, kept_at = NULL`;
};

// The keep link's account, or undefined. Used by the GET, which changes nothing.
exports.findByToken = async function (token) {
  const [row] = await sql`
    SELECT user_id, notified_at FROM auth_account_notice WHERE keep_token_hash = ${hash(token)}`;
  return row;
};

// Spends the token: one confirmation per warning.
exports.keepByToken = async function (token) {
  const [row] = await sql`
    UPDATE auth_account_notice SET kept_at = now(), keep_token_hash = NULL
    WHERE keep_token_hash = ${hash(token)}
    RETURNING user_id`;
  return row;
};

// A superadmin knows this person is still about.
exports.keep = async function (userId) {
  await sql`
    INSERT INTO auth_account_notice (user_id, kept_at) VALUES (${userId}, now())
    ON CONFLICT (user_id) DO UPDATE SET kept_at = now(), keep_token_hash = NULL`;
};

exports.remove = async function (userId) {
  await sql`DELETE FROM auth_account_notice WHERE user_id = ${userId}`;
};

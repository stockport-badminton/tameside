-- One person, several login identities.
--
-- player."authEmail" (migrations/player-auth-roles.sql) is a single column, so a player
-- row could record exactly one Auth0 login address. That does not survive contact with
-- the real tenant:
--
--   * The league's own results mailbox exists twice — stockport.badders.results@ and
--     tameside.badders.results@ — and both are superadmin. One player row, one column,
--     so one of them silently lost its role.
--   * Three addresses in the tenant carry TWO Auth0 identities each: a password login
--     (`auth0|…`) and a Google login (`google-oauth2|…`). Those happen to share an
--     address, so matching by address covered them — but nothing guaranteed that, and a
--     person with two *different* addresses had no way to be represented.
--
-- So auth addresses move to their own table. Additive and idempotent, same as the rest
-- of migrations/.
--
-- Still encrypted, for the same reason playerEmail is: these rows identify the highest
-- privilege accounts on the site, and a plaintext lookup column would undo that.

CREATE TABLE IF NOT EXISTS player_auth_email (
  id         bigserial PRIMARY KEY,
  player     bigint NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  email      bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- getAuthRoleByEmail joins this per login, so the lookup from player -> addresses has
-- to be cheap. The address itself can't be indexed (it is encrypted, and the comparison
-- decrypts), which is why that query stays restricted to players holding a role.
CREATE INDEX IF NOT EXISTS player_auth_email_player_idx ON player_auth_email (player);

-- Carry over whatever the single column already holds.
--
-- Guarded on the player having no rows yet rather than on the address not being present,
-- because checking the address would mean decrypting inside the migration and therefore
-- passing DB_ENCODE into a .sql file. Idempotent either way: re-running this cannot
-- duplicate a row, and cannot clobber an address added since.
INSERT INTO player_auth_email (player, email)
SELECT player.id, player."authEmail"
FROM player
WHERE player."authEmail" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM player_auth_email pae WHERE pae.player = player.id
  );

-- player."authEmail" is now superseded and no longer read or written by the app. Left in
-- place deliberately: it is the rollback path until this table has been through a real
-- cutover. Drop it in a follow-up once that is proven —
--   ALTER TABLE player DROP COLUMN "authEmail";
-- and not before, because nothing else records what those addresses were.

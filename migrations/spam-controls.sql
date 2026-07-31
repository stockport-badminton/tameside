-- Spam controls: blocklists that don't need a deploy, and a record of what was blocked.
--
-- Ported from the Stockport league site (its migrations/010_spam_controls.sql). Before
-- this, blocking a spammer meant editing controllers/contactusController.js and shipping:
-- 26 email addresses and ~180 phrases were hardcoded in two arrays there. Those 26
-- addresses are the evidence — each one is somebody hand-editing source and deploying
-- because a new spammer turned up.
--
-- Safe to re-run: every statement is IF NOT EXISTS or ON CONFLICT DO NOTHING, and nothing
-- here alters or drops an existing table.

CREATE TABLE IF NOT EXISTS blocked_entry (
  id          SERIAL PRIMARY KEY,
  -- 'ip'     exact match on the resolved client address
  -- 'email'  exact match (case-insensitive) on a submitted email address
  -- 'phrase' case-insensitive substring of the message body
  -- 'word'   case-insensitive whole-word match in the message body
  kind        TEXT NOT NULL CHECK (kind IN ('ip', 'email', 'phrase', 'word')),
  value       TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT,
  -- Kept rather than deleted so an entry can be switched off without losing the note
  -- explaining why it was ever added.
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

-- Case-insensitive uniqueness per kind: the same address added twice is a mistake, and the
-- admin screen should say so rather than silently duplicating. models/spamControls.add()
-- names this exact expression as its ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS blocked_entry_kind_value_idx
  ON blocked_entry (kind, LOWER(value));

CREATE INDEX IF NOT EXISTS blocked_entry_active_idx
  ON blocked_entry (kind) WHERE active;

-- Every public submission and what happened to it.
--
-- There was no request logging of any kind, so nobody could answer "is this 3 a week or
-- 300?" — which also means there was no way to tell whether any of this work helped.
-- Deliberately narrow: enough to recognise a pattern and to justify adding a blocklist
-- entry, without keeping a copy of everything anyone ever typed.
CREATE TABLE IF NOT EXISTS submission_log (
  id            SERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  endpoint      TEXT NOT NULL,
  ip            TEXT,
  -- The raw X-Forwarded-For alongside the resolved address, because the resolved one is
  -- the leftmost entry and therefore client-settable — see utils/clientIp.js. Check this
  -- before blocking an address by hand.
  forwarded_for TEXT,
  user_agent    TEXT,
  -- 'accepted' | 'rejected'
  verdict       TEXT NOT NULL,
  -- Which check rejected it: 'captcha', 'honeypot', 'too-fast', 'bad-stamp',
  -- 'blocked-ip', 'blocked-email', 'blocked-phrase', 'blocked-word', 'validation',
  -- or NULL when accepted.
  reason        TEXT,
  email         TEXT,
  -- First 200 characters only. Enough to recognise a campaign, not a message archive.
  excerpt       TEXT
);

CREATE INDEX IF NOT EXISTS submission_log_created_idx ON submission_log (created_at DESC);
CREATE INDEX IF NOT EXISTS submission_log_verdict_idx ON submission_log (verdict, created_at DESC);

-- ---------------------------------------------------------------------------------------
-- Seed from what was hardcoded, minus what shouldn't have been there.
--
-- The ~180-entry profanity array is deliberately NOT seeded, following the same call
-- Stockport made: it's politeness policing rather than spam defence, and it costs
-- legitimate messages. It contained "hell", "gay", "sex" and "ass" as bare substrings.
--
-- Four entries from the *spam* half are also dropped, because as case-insensitive
-- substrings they block real people outright:
--   'Christ'     matches Christine, Christopher, Christ Church — very common
--   'God'        matches Goddard, Godfrey, Godwin — real surnames
--   'Bing'       matches Bingham, Bingley
--   'http'/'https' bare — superseded by 'http://' and 'https://' below
-- 'SEO' and 'Consultant' were substrings too; SEO is kept as a whole-word entry instead,
-- and Consultant is dropped as too ordinary a word to block.
--
-- Anything dropped here can be put back from /admin/spam without a deploy, which is the
-- whole point of the table.
-- ---------------------------------------------------------------------------------------

INSERT INTO blocked_entry (kind, value, note, created_by) VALUES
  ('phrase', 'http://',                  'Link spam — the single most effective rule', 'migration spam-controls'),
  ('phrase', 'https://',                 'Link spam', 'migration spam-controls'),
  ('phrase', 'Website Design',           'Agency spam', 'migration spam-controls'),
  ('phrase', 'Digital Marketing',        'Agency spam', 'migration spam-controls'),
  ('phrase', 'brokerage',                'Finance spam', 'migration spam-controls'),
  ('phrase', 'pharm',                    'Pharma spam', 'migration spam-controls'),
  ('phrase', 'blockchain',               'Crypto spam', 'migration spam-controls'),
  ('phrase', 'Cryptocurrency',           'Crypto spam', 'migration spam-controls'),
  ('phrase', '@Cryptaxbot',              'Crypto spam', 'migration spam-controls'),
  ('phrase', 'forex',                    'Finance spam', 'migration spam-controls'),
  ('phrase', 'adultdating',              'Adult spam', 'migration spam-controls'),
  ('phrase', 'xrated',                   'Adult spam', 'migration spam-controls'),
  ('phrase', '000***',                   'Seen in finance spam', 'migration spam-controls'),
  ('phrase', '@FeedbackMessages',        'Bot signature', 'migration spam-controls'),
  ('phrase', 'messages exploitation',    'Bot signature', 'migration spam-controls'),
  ('phrase', 'Financial Strategic Firm', 'Finance spam', 'migration spam-controls'),
  ('phrase', 'Business Financial Team',  'Finance spam', 'migration spam-controls'),
  ('phrase', 'wininphone',               'Bot signature', 'migration spam-controls'),
  ('phrase', 'corta.co',                 'Spam domain', 'migration spam-controls'),
  ('phrase', 'mail.ru',                  'Spam domain', 'migration spam-controls')
ON CONFLICT (kind, LOWER(value)) DO NOTHING;

-- Whole-word rather than substring, so it can't match inside an ordinary word.
INSERT INTO blocked_entry (kind, value, note, created_by) VALUES
  ('word', 'SEO', 'Agency spam — whole word only, so it cannot match inside another word', 'migration spam-controls')
ON CONFLICT (kind, LOWER(value)) DO NOTHING;

-- The 26 spammer addresses that were hardcoded in containsDodgyEmail.
INSERT INTO blocked_entry (kind, value, note, created_by) VALUES
  ('email', 'dhgpokrq@streetwormail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'seorankingtech@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'denisberger.web@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'dianacruz.mkt@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'applicationdevelopment03@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'bemibrooks.dev@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'pageranktechnology@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'sales@rankinghat.co', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'yjdisantoyjdissemin@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'lucido.leinteract@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'projectdept@kanzalshamsprojectmgt.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'evalidator.test@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'simpsonmiddleton1111@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'simpsonmiddleton@bankingandfinanceconsultantsltd.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'breiner@cljfarmaceutisch.nl', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'drbreiner233@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'smithduncan610@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', '5rdhp2fe29yb@beconfidential.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'stevenlove88@163.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'artweb.agency@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'help@aweb.sbs', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'hrhbah-mbi@aghemfondom.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'hrhmbambi@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'nhu-tran@sac-city.k12.ca.us', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'yourmail@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls'),
  ('email', 'kaenquirynicholls@gmail.com', 'Seeded from the hardcoded list in contactusController.js', 'migration spam-controls')
ON CONFLICT (kind, LOWER(value)) DO NOTHING;

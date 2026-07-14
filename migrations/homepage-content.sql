-- Content-managed homepage announcements + generic site settings.
-- Replaces the hardcoded News cards in views/homepage.ejs with admin-editable
-- rows, and moves the Cloudinary gallery tag out of code.
-- Apply manually via the Supabase SQL editor (or psql). Idempotent.

CREATE TABLE IF NOT EXISTS homepage_announcement (
  id                 SERIAL PRIMARY KEY,
  title              TEXT NOT NULL,
  teaser_html        TEXT NOT NULL,
  modal_body_html    TEXT,
  image_url          TEXT,
  show_gallery_link  BOOLEAN NOT NULL DEFAULT false,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_setting (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Same Cloudinary tag fixtureController.js had hardcoded. NOTE: the fetched
-- assets are not currently rendered by any tameside view (kept for behaviour
-- parity / a future gallery).
INSERT INTO site_setting (key, value) VALUES ('homepage_gallery_tag', 'messer2024')
ON CONFLICT (key) DO NOTHING;

-- The current hardcoded homepage.ejs News cards converted to rows so the feed
-- isn't empty after this ships. Guarded so re-running the migration doesn't
-- duplicate them.
INSERT INTO homepage_announcement (title, teaser_html, modal_body_html, image_url, show_gallery_link, sort_order, active)
SELECT * FROM (VALUES
(
  'Updates',
  '<p>Some improvements for you all. For all of you with scorecard photos on your phone, but entering results on another device:</p><p>Skip the photo stage for the initial entry, and then return to the <a href="/email-scorecard">results entry page</a> and you''ll find a list of your scorecards that still need photos. Now you can enter the scorecard info in one place and then upload the photo from your phone separately.</p>',
  NULL::text, NULL::text, false, 1, true
),
(
  'Player Registrations',
  '<p>If captains / teams could endeavor to email me before/during a match where a new player is being added that will help smooth scorecard entry.</p><p>There''s no need to send scorecards directly to Jonny anymore - you can <a href="/email-scorecard">enter them online</a> and he will receive them.</p>',
  NULL::text, NULL::text, false, 2, true
),
(
  'Results Entry System',
  '<p><a href="#" data-bs-toggle="modal" data-bs-target="#resultsEntryModal">A quick guide to results entry</a></p><p>Questions / suggestions are always welcome - use the contact us menu to get in touch with me.</p><p><strong>Neil</strong></p>',
  NULL::text, NULL::text, false, 3, true
)) AS seed(title, teaser_html, modal_body_html, image_url, show_gallery_link, sort_order, active)
WHERE NOT EXISTS (SELECT 1 FROM homepage_announcement);

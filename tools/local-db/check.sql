-- Fails the load (tools/local-db.sh) if the local copy still holds anyone's contact details.
-- Run after scrub.sql, with the same  SET tbl.local_key = '...';
--
-- It does not trust the list in scrub.sql. It scans EVERY bytea column and every text
-- column in public, so a contact column added next season fails the load until scrub.sql
-- learns about it, rather than quietly copying real addresses to a laptop.
--
-- No production key is involved: a value passes only if it decrypts with the LOCAL key to
-- one of scrub.sql's fakes, which proves it was rewritten here.

DO $$
DECLARE
  k        text := current_setting('tbl.local_key');
  r        record;
  v        bytea;
  plain    text;
  bad      int;
  n        bigint;
  t        text;
  problems text[] := '{}';
  -- Mail, sessions, push, contact-form and login-cull rows: their data is never dumped.
  emptied  text[] := ARRAY['session', 'inbound_email', 'inbound_email_delivery',
                           'registration_request', 'rearrangement_request', 'submission_log',
                           'push_subscription', 'push_send', 'auth_account_notice',
                           'social_result_post', 'transactions'];
  -- Public addresses that may appear in page content: the league's own domain.
  public_domains text := '(tameside-badminton\.co\.uk|example\.invalid)$';
BEGIN
  -- 1. Every encrypted value is one of ours.
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type = 'bytea' ORDER BY 1, 2
  LOOP
    bad := 0;
    FOR v IN EXECUTE format('SELECT %I FROM public.%I WHERE %I IS NOT NULL', r.column_name, r.table_name, r.column_name) LOOP
      BEGIN
        plain := pgp_sym_decrypt(v, k);
      EXCEPTION WHEN OTHERS THEN
        plain := NULL;
      END;
      IF plain IS NULL OR NOT (plain ~ '@example\.invalid$' OR plain ~ '^07700 900[0-9]{3}$') THEN
        bad := bad + 1;
      END IF;
    END LOOP;
    IF bad > 0 THEN
      problems := problems || format('%s.%s: %s value(s) not rewritten', r.table_name, r.column_name, bad);
    END IF;
  END LOOP;

  -- 2. No plain-text email address anywhere, other than the league's own and our fakes.
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying') ORDER BY 1, 2
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I, LATERAL regexp_matches(%I, %L, %L) m
        WHERE m[1] !~* %L',
      r.table_name, r.column_name, '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})', 'g', public_domains)
      INTO n;
    IF n > 0 THEN
      problems := problems || format('%s.%s: %s plain-text address(es)', r.table_name, r.column_name, n);
    END IF;
  END LOOP;

  -- 2b. No UK phone number in plain text (01/02/03/07 numbers, spaced or not).
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying') ORDER BY 1, 2
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I, LATERAL regexp_matches(%I, %L, %L) m
        WHERE m[1] !~ %L',
      r.table_name, r.column_name,
      '(?:^|[^0-9])((?:\+44 ?|0)(?:1|2|3|7)[0-9]{2,3}[ -]?[0-9]{3}[ -]?[0-9]{3,4})(?:[^0-9]|$)', 'g',
      '^07700 ?900')
      INTO n;
    IF n > 0 THEN
      problems := problems || format('%s.%s: %s plain-text phone number(s)', r.table_name, r.column_name, n);
    END IF;
  END LOOP;

  -- 3. The tables whose rows were never copied are empty.
  FOREACH t IN ARRAY emptied LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN problems := problems || format('%s: %s row(s), expected none', t, n); END IF;
    END IF;
  END LOOP;

  -- 4. Login ids are fakes; the blocklist holds no addresses or IPs.
  SELECT count(*) INTO n FROM player_auth_account WHERE user_id NOT LIKE 'local|%';
  IF n > 0 THEN problems := problems || format('player_auth_account: %s real login id(s)', n); END IF;
  SELECT count(*) INTO n FROM blocked_entry WHERE kind IN ('ip', 'email');
  IF n > 0 THEN problems := problems || format('blocked_entry: %s ip/email row(s)', n); END IF;

  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'local copy is NOT clean: %', array_to_string(problems, '; ');
  END IF;
  RAISE NOTICE 'clean: every contact value is a local fake';
END $$;

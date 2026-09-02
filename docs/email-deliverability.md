# Email deliverability runbook

Everything the league sends goes through Mailjet from `results@tameside-badminton.co.uk`.
This is what is set up, what is missing, and what to do when someone says they are not
getting emails.

Measured 2 Sep 2026 unless stated.

## Where it stands

| | |
|---|---|
| Lifetime delivered | 2,317 |
| Blocked | 39 (1.7%) |
| Bounced | 3, all soft — **zero hard bounces** |
| SPF | present, includes Mailjet — Mailjet's own check says **OK** |
| DKIM | present at selector `mailjet` — Mailjet's own check says **OK** |
| **DMARC** | **absent** — the one real gap |

## The one thing to add: DMARC

Add this TXT record at the registrar:

```
name:  _dmarc.tameside-badminton.co.uk
type:  TXT
value: v=DMARC1; p=none; rua=mailto:dmarc@tameside-badminton.co.uk; fo=1
```

- **`p=none` first.** It changes nothing about how mail is treated; it only asks receivers
  to send reports. Move to `p=quarantine` once a few weeks of reports show nothing
  legitimate failing.
- **`rua` must be an address on this domain.** Pointing it at a gmail address requires
  gmail to publish an authorising record (`tameside-badminton.co.uk._report._dmarc.gmail.com`),
  which we cannot create. The domain already uses registrar email forwarding
  (`eforward1-5.registrar-servers.com`), so add a forward for `dmarc@` to wherever you
  want the reports.
- **It will pass on DKIM, not SPF.** Mailjet sends with its own Return-Path, so SPF is not
  *aligned* with the From domain even though it passes. DKIM signs as
  `d=tameside-badminton.co.uk`, which is aligned, and DMARC needs only one of the two. This
  is why adding the record is safe rather than risky — but check the first reports before
  tightening `p`.

Leave SPF and DKIM alone. SPF is currently
`v=spf1 include:spf.mailjet.com include:spf.efwd.registrar-servers.com ~all`, which is
stricter than the `?all` Mailjet suggests and also covers the forwarder. The DKIM record
does not declare `v=DKIM1;` — that tag is RECOMMENDED rather than required by RFC 6376,
verifiers tolerate its absence, and Mailjet validates the record as-is, so it is not worth
touching.

> **SNDS and JMRP are not available to us.** Microsoft's sender programmes are registered
> per *IP address*, and this account sends from Mailjet's shared IPs, which we do not own.
> Those are Mailjet's to run. A dedicated IP would make them possible but needs far more
> volume than a badminton league produces to build its own reputation — on low volume a
> dedicated IP is usually *worse* than a good shared pool.

## When someone says they are not getting emails

**Check the contact first.** This is what found the one real case:

```bash
set -a; . ./.env; set +a
curl -s -u "$MAILJET_KEY:$MAILJET_SECRET" \
  "https://api.mailjet.com/v3/REST/contact/THEIR@ADDRESS" | python3 -m json.tool
```

`IsSpamComplaining: true` means they clicked Junk (or their provider's feedback loop
reported it) and **Mailjet now suppresses that address permanently**. No bounce, no
rejection, no log line — mail simply stops. `peter.taylor13@outlook.com` is in exactly
this state, flagged since 24 Oct 2024.

To fix one: delete the contact in Mailjet (Contacts → the address → delete, or the v4
contacts delete endpoint), which clears the flag; it is recreated clean on the next send.
Then ask them to find one in Junk and mark it **not junk**, and add
`results@tameside-badminton.co.uk` to their safe senders — otherwise they will re-flag
themselves and you are back where you started.

### Three Mailjet API traps

Do not trust these; all three were checked and are wrong or useless:

- **List filters are silently ignored.** `/v3/REST/contact?IsSpamComplaining=true`,
  `=false`, and no filter at all return the identical 50 rows. A list that appeared to show
  50 spam complainers — including the league's own results mailbox and the site's own From
  address — was an artefact of this. Only the **per-contact** lookup is meaningful.
- **`DeliveredCount` reads 0 for everybody**, including addresses observed receiving and
  opening mail. It means nothing on that endpoint.
- **`/v3/REST/message?Status=blocked` ignores the status too** and returns recently
  *delivered* messages. There is no way to list the historical blocks.

## Capturing the reason next time

`POST /webhooks/mailjet` receives Mailjet's event callbacks and logs them. Configure it in
Mailjet (Account → Event notifications) as:

```
https://tameside-badminton.co.uk/webhooks/mailjet?t=<MAILJET_WEBHOOK_TOKEN>
```

and set `MAILJET_WEBHOOK_TOKEN` in Cloud Run to the same value. Tick at least **bounce,
blocked, spam and unsub**. Until the token is set the route 404s, so it is inert.

A `blocked` or `bounce` event carries the receiving server's own text, which is the
difference between "Outlook is blocking us" and a diagnosis. Events that mean somebody has
stopped receiving mail are logged with `console.error`, so:

```bash
gcloud logging read \
  'resource.labels.service_name="tameside-site" AND textPayload:"[mailjet]"' \
  --project=avid-compound-429108-g9 --account=tameside.badders.results@gmail.com \
  --freshness=30d --format="value(timestamp,textPayload)"
```

Worth considering later: a small `email_event` table so complaints survive log retention
and can be shown on an admin screen. Not built — logging covers the diagnosis, and the
table only earns its place if this happens often.

## Why the emails themselves matter here

The old emails looked like marketing: a SendGrid-exported template, hotlinked social icons
from `marketing-image-production.s3.amazonaws.com`, and nothing saying who was writing or
why. That is what makes a captain reach for Junk on a message they actually asked for — and
one junk click costs that address permanently.

Every template now carries a footer saying who we are, why this arrived and how to reply,
and `test/email-templates.test.js` fails if one loses it. See **Emails** in CLAUDE.md for
how the templates are built.

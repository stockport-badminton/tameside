# BL-04: Inbound email through Resend (league lists, then registrations@)

Raised 6 Nov 2026. Ours alone in the *how*: Stockport receives through SES (`POST /mail`,
SNS-signed, `middleware/verifySns.js`), and we have no AWS mail account. The *what* is
theirs and is the reference: league-site `controllers/contactusController.js`
(`distribution_list`) and `controllers/playerRequestController.js` (`registrations@`).

## Status (7 Nov 2026)

**Steps 1-5 and 7 are built**: `POST /webhooks/resend`, `utils/listAddress.js`,
`utils/svixSignature.js`, `utils/resendInbound.js`, `models/inboundEmail.js`,
`mailer.forward`, `/admin/inbound-email`, `migrations/inbound-email.sql`; CLAUDE.md has the
rules. **Step 6: `registrations@` is built (8 Nov 2026)**, `rearrangements@` is not: until
it is, mail to it is `not-a-list` and dropped.

registrations@, decided while building: same sender gate as a list (known + authenticated),
not Stockport's `REGISTRATION_INBOX_SENDERS` allowlist, so no new env var and a club
secretary can write to it directly. A refusal shows on `/admin/player-requests`. Teams on
offer are those in a real division (Stockport's "not No Club" would also offer the other
league's club rows here). No e2e spec yet: Stockport's runs on their local DB fixtures, and
ours reads production, which has no request rows. Go-live: apply
`migrations/registration-request.sql`, deploy, mail `registrations@` from a login address.

Differences from the plan below, decided while building:
- **Authenticated means DMARC pass, or DKIM pass only when DMARC is not `fail`.** "DKIM
  pass" alone lets anyone sign with their own domain and put a captain's address in From.
- **The visible To is the results mailbox, plus-tagged with the list**
  (`tameside.badders.results+hyde@gmail.com`), as Stockport's is. Sending To the list
  address itself would come straight back through the catch-all and spend the quota.
- **List mail reaches teams in a real division only** (`getEmails({ inDivision: true })`).
  Measured on production: 63 addresses for every role-holder, 37 within the two
  divisions. The rest are role flags left on players parked at No Club.
- `leaguecomms@` (the otherComms flag) is accepted too, as Stockport's is.
- **No `List-Id`**: Mailjet refuses it in `Headers` and fails the send. The first live
  forward did exactly that. `X-Tameside-List` carries the list instead, for the loop guard.
- Rehearsed against production in a rolled-back transaction: the migration, claim and
  retry-after-failure, per-recipient dedupe, the vocabulary (12 clubs, 2 divisions; No
  Club excluded), and the known-sender check (superadmin login yes, a Hyde contact yes, a
  No Club contact no).

**Go-live, in order:** apply `migrations/inbound-email.sql`; set `RESEND_API_KEY`,
`RESEND_WEBHOOK_SECRET` and `RESEND_INBOUND_DOMAIN` on Cloud Run (`--update-env-vars`);
deploy; enable webhook `b80ef776…` in Resend; send a mail with `test` in the subject to
`hydeteamcaptains@` and check the results mailbox.

## Goal

Mail to a list address reaches everyone on that list. After that, `registrations@` feeds a
review queue the way Stockport's does.

List addresses **combine** a division, a club and a role, as Stockport's do: `division1@`,
`hyde@`, `teamCaptains@`, `hydeteamCaptains@`, `division1teamCaptains@`. That is too many
combinations to keep as one Namecheap forward each, so the addresses are resolved in code,
not listed in DNS config.

**Resend receives the mail. Mailjet still sends everything.** Sending stays where its
reputation already is, and receiving is the only thing Resend adds.

## Shape

```
captain → hydeteamCaptains@tameside-badminton.co.uk
        → Namecheap email forwarding: no explicit forward matches, so the CATCH-ALL
        → inbound@<id>.resend.app   (the account's Resend-managed receiving domain)
        → Resend stores it, POSTs email.received to /webhooks/resend
        → we GET the email from Resend, recover the ORIGINAL league address, parse it
          into division/club/role, resolve the list from the DB, check the sender
        → Mailjet, Bcc'd to the list
```

**The named mailboxes stay as they are.** `results@`, `dmarc@`, `info@` and every other
real address keep their explicit Namecheap forwards to Gmail, and explicit forwards take
precedence over the catch-all. Only addresses that have no forward of their own fall
through to Resend.

**No DNS changes at all.** The MX stays on Namecheap's forwarders.

### Gate 0: PASSED 7 Nov 2026

Tested To, Cc and Bcc through the live catch-all. In all three, including Bcc, Namecheap's
forwarder adds **`X-Original-To: <hydetest@tameside-badminton.co.uk>`** and a
`Received: … by eforward.registrar-servers.com … for <hydetest@…>` line. Resend's
`received_for` came back as `["inbound@thaizorae.resend.app", "hydetest@tameside-badminton.co.uk"]`.
`authentication` was spf/dkim/dmarc all `pass` from Gmail: Gmail's DKIM survives the
forward, so the DMARC/DKIM gate in step 4 works on forwarded mail.

What follows from it:
- **Take the address from the TOPMOST `X-Original-To`**, the one Namecheap added, and
  cross-check it against `received_for`. Anything lower down the headers was written by
  the sender and can be forged: a crafted `X-Original-To` or `Received: … for <division1@…>`
  in the original message would also appear in `received_for`. The sender gate limits
  what that could do, but the routing shouldn't trust it either.
- **Each league address arrives as its own Resend email.** That's Postfix's
  single-recipient `for`; presumed, not yet tested with two list addresses on one mail.
  So "to `division1@` and `hyde@`" is two webhooks, and a person on both lists would get
  it twice unless sends are deduplicated by **`Message-ID` + recipient** across
  deliveries, not by `email_id`.
- Namecheap's own `Authentication-Results` header is in the message. Ignore it and use
  Resend's top-level `authentication` only.

### Gate 0 as planned (kept for the record)

After a forward, the envelope recipient Resend sees is `inbound@<id>.resend.app` for every
list, so `received_for`'s local part no longer names the list. The league address has to
come from somewhere else in the message:

- the **`To`/`Cc` headers**. Present unless the list was Bcc'd, which is normal for list
  mail.
- a **`Received: … for <hydeteamCaptains@tameside-badminton.co.uk>`** header added by
  Namecheap's MX, or an `X-Original-To` / `Delivered-To` header, if Namecheap adds one.
  Resend's `received_for` is read from `Received` `for` clauses, so it may already carry
  this.

**Test:** with the catch-all in place, send three mails: `To: hydetest@`, `Cc: hydetest@`,
and `Bcc: hydetest@` with some other `To`. For each, read the raw message
(`raw.download_url`) and `received_for`. If the Bcc case still names `hydetest@` somewhere
Namecheap put it, the catch-all design works. If it doesn't, a Bcc'd list mail can't be
routed. Then either tell posters "put the list in To or Cc" (the handler replies to the
sender saying so), or fall back to one explicit forward per list for the few that
matter, with the list name in the target's local part.

### Spam and the quota

A catch-all receives mail for **every** address nobody has claimed, including dictionary
attacks on a domain that has been public for years. Every one of those counts against
Resend's free **100 a day**, and once the cap is hit, real list mail that day is lost.

- **Watch the counts.** `inbound_email` logs every arrival with its outcome. A daily
  count, or a line on `/admin`, shows how fast it's filling. Pro is $20/mo with no daily
  cap, if it ever comes to that.
- **Cherry-pick.** An address that attracts spam gets an explicit Namecheap forward to
  somewhere harmless. That takes it out of the catch-all. (Namecheap has no "discard"
  target, as far as we know; a forward to a Gmail address with a filter that deletes it
  does the job.)
- **Never forward unrecognised mail through Mailjet,** not even to the results mailbox.
  Relaying spam from our own sending domain is the fastest way to spend the reputation
  this design exists to protect. Anything refused is dropped, logged, and kept in Resend's
  dashboard for 30 days.

**Check before switching it on: is there a catch-all today?** If Namecheap already
forwards `*` to Gmail, then addresses with no explicit forward currently reach a person.
List those that matter (look at what's in that Gmail inbox) and give each an explicit
forward first.

### Why not a `lists.` subdomain

That was the first plan, and Resend's docs recommend it. **Namecheap won't allow it**
(checked 6 Nov 2026): while Mail Settings is on *Email Forwarding*, Host Records offers no
MX type. The other choices on that dropdown (*MXE*, *Custom MX*, *Private Email*, *Gmail*)
all replace the forwarding that serves every existing address. *MXE* takes an IP address,
and Resend gives a hostname. **Don't switch the dropdown.**

The resend.app address costs two things:
- **The receiving address isn't ours.** It is in Namecheap's forwarding config and nowhere
  public. Anyone who learns the `<id>` can still post to it, which the sender gate below
  handles anyway.
- **Resend could change it.** If the account ever has to be recreated, the catch-all has
  to be repointed. Keep the address in one place: `RESEND_INBOUND_DOMAIN`.

## Setup (Neil: Resend dashboard and Namecheap)

1. **Resend:** create an account. Under Receiving, note the account's `<id>.resend.app`
   address. Make a webhook pointing at `https://tameside-badminton.co.uk/webhooks/resend`,
   with event `email.received`. Keep its signing secret (`whsec_…`) and an API key.
2. **Namecheap → Domain List → Manage → Domain tab → Redirect Email:** write down the
   current forwards and whether a catch-all exists. Then set the catch-all (`*`) to
   `inbound@<id>.resend.app`. With no webhook yet, Resend just stores the mail, which is
   exactly what Gate 0 needs.
3. **Run Gate 0.**
4. **Cloud Run:** `--update-env-vars RESEND_API_KEY=…,RESEND_WEBHOOK_SECRET=…,RESEND_INBOUND_DOMAIN=<id>.resend.app`
   (never `--set-env-vars`).

## Build

1. **`POST /webhooks/resend`**, `access.token`-style declaration in the route table.
   - Use the raw body (`express.raw`). Svix signs `${svix-id}.${svix-timestamp}.${body}`
     with HMAC-SHA256, keyed by the base64 part of `whsec_…`. Compare in constant time and
     refuse a timestamp more than 5 minutes old. That's about 20 lines with `crypto`, so no
     `svix` or `resend` dependency (this repo uses `fetch`, not SDKs). Answer **404** when
     the signature is missing or bad, and when the secret is unset, like
     `/webhooks/mailjet`.
   - Delivery is at-least-once, so dedupe on `data.email_id` with a table
     `inbound_email (email_id PK, league_address, list, sender, outcome, created_at)`,
     using `INSERT … ON CONFLICT DO NOTHING`. That table is also the log and the spam
     counter.
   - Do the work **before** responding: Cloud Run throttles the CPU after the response.
     The 60s ceiling is plenty for one GET to Resend plus one or two Mailjet calls.
2. **Fetch:** `GET https://api.resend.com/emails/receiving/{id}` returns `html`, `text`,
   `headers`, `attachments`, `received_for`, `authentication.{spf,dkim,dmarc}`, and
   `raw.download_url`. Attachments come from the attachments endpoint. Mailjet inlines
   attachments and refuses anything over 15MB, so anything bigger gets a "too large, see the
   original" line instead.
3. **Which list:** collect every `@tameside-badminton.co.uk` address from wherever Gate 0
   found them reliably. More than one can match, as when a mail goes to `division1@` and
   `division2@`: the recipients are the union, sent once each.
   - **Parse a local part into `{division?, club?, role?}`**, using vocabularies built
     from the DB: `division` names, `club` names normalised the way
     `registrationDiff` already does (`G.H.A.P` → `ghap`), and a fixed role list
     (`teamCaptains`, `clubSecretaries`, `matchSecretaries`, `treasurers`). Unlike
     Stockport's, the parse is **exact**. Their `indexOf` matching means any address
     containing "dome" means Dome, so a typo or a spammer's guess still reaches a real list.
     Ours must consume the whole local part or match nothing.
   - **No match means drop, not forward.** It also means the address isn't a list, so
     `registrations@` (step 6) and the named mailboxes never reach this parser.
   - `test` in the subject sends only to the results mailbox, with the resolved
     recipients listed, as Stockport's does. That's the way to check a new combination
     before it reaches anyone.
4. **Who may post.** Stockport has no check on who may post. Anyone who knows the address
   can mail a whole division. We need both of these:
   - The sender is a known address: a player contact or login address, or a club officer.
   - The sender is genuine: `dmarc === 'pass'`, or failing that `dkim === 'pass'`.
     **SPF proves nothing here.** After Namecheap forwards the mail, SPF is checked against
     Namecheap's forwarder, which our own SPF record already includes. So a "pass" there is
     a pass for us, not for the sender. Stockport's `registrations@` accepts
     `dkim PASS || spf PASS`, and copying that would let anything through. Measure what real
     forwarded mail looks like (the `inbound_email` rows) before turning the gate on.
   - A refusal is logged, not forwarded (see "Spam and the quota"). The superadmin sees
     the refusals on a list page with the sender, address and reason, so a real captain
     who was refused can be found and allowed.
5. **Send:** with our address in From and the sender's name as the display name, Reply-To
   pointing at the sender, an `X-Original-From` header, `List-Id`, and `List-Unsubscribe`
   (the mailto form; see Stockport's comment for why not one-click). Recipients go in Bcc,
   in chunks if Mailjet's per-message recipient limit needs it. `utils/mailer.send`
   requires a template, so a forward needs a passthrough path for the original `html`/`text`
   that still keeps the "every email needs a text part" rule. Loop guard: drop anything
   carrying our own `List-Id`, or sent from `RESEND_INBOUND_DOMAIN`.
6. **Then `registrations@` and `rearrangements@`** (the second added 8 Nov 2026: Stockport
   queues it the same way, `controllers/rearrangementRequestController.js`, for
   `/admin/rearrangements`; same rules as registrations@ below). Each is a separate step: port Stockport's player-requests queue
   (`playerRequestController`, `models/registrationRequest`, `utils/registrationEmail`).
   `nameMatch` is already ported. It arrives by the catch-all like any list. Stockport
   falls back to forwarding when an email can't be queued; here a refusal shows on the
   queue page instead, for the reason in step 4.
7. **Paperwork:** a line in `views/privacy.ejs` (Resend is a new processor; check where it
   stores received mail), a CLAUDE.md section, the env vars, and `docs/routes.md`.

## Tests

- A bad, missing or stale signature gets a 404 and makes no Resend fetch.
- A duplicate `email_id` sends once.
- The local-part parser: every single-part and combined form, case-insensitive;
  `hydex@`, `xhyde@` and `domestic@` match nothing.
- Two list addresses on one mail give the union, and each person gets it once.
- A sender with SPF pass but DKIM/DMARC fail is refused.
- An unknown sender or address reaches **nothing**: assert Mailjet was never called, as
  `abuse-gating.test.js` does.
- The Gate 0 result, once known, is pinned with a fixture made from the real forwarded
  raw message, with addresses replaced.

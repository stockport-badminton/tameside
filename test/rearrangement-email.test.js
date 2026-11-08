// utils/rearrangementEmail.js — the first reading of a rearrangement email. Ported from
// Stockport's __tests__/unit/rearrangement-email.test.js (jest there, node:test here); the
// parser is verbatim, so these are their samples and their club ids.
//
// The five emails below are the first real ones (Oct–Nov 2026) with the people's names and
// addresses replaced; their shape, dates and club names are as they arrived. The fixtures
// in `before` are those matches as they stood BEFORE each was applied.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readRearrangementEmail, propose, seasonYear } = require('../utils/rearrangementEmail');

const clubs = [[42, 'Aerospace'], [43, 'Alderley Park'], [49, 'Cheadle Hulme'], [61, 'College Green'],
  [50, 'David Lloyd'], [51, 'Disley'], [52, 'Dome'], [53, 'G.H.A.P'], [39, 'Mellor'], [57, 'Parrs Wood'],
  [59, 'Racketeer'], [41, 'Syddal Park']].map(([id, name]) => ({ id, name }));
const teams = [[4, 'Racketeers A', 59], [8, 'Racketeers B', 59], [20, 'Syddal Park A', 41], [21, 'Syddal Park B', 41],
  [30, 'Disley A', 51], [31, 'Cheadle Hulme A', 49], [32, 'Cheadle Hulme B', 49], [40, 'Dome B', 52],
  [41, 'College Green C', 61], [42, 'College Green B', 61], [43, 'Alderley Park B', 43], [44, 'Aerospace A', 42],
  [45, 'Mellor A', 39], [46, 'GHAP A', 53], [47, 'Parrswood A', 57]].map(([id, name, clubId]) => ({ id, name, clubId }));

const read = (subject, text, receivedYmd, headerFrom = 'Results <results@example.invalid>') =>
  readRearrangementEmail({ subject, text, headerFrom, receivedYmd, clubs, teams });
const pick = (p) => ({ fixtureId: p.fixtureId, newDate: p.newDate });
const fx = (id, date, home, away, status = 'outstanding') => {
  const t = n => teams.find(x => x.name === n);
  return { id, date, status, homeTeamId: t(home).id, awayTeamId: t(away).id, homeClubId: t(home).clubId, awayClubId: t(away).clubId };
};

const RACKETEERS = `Hi Neil,

Just wanted to let you know that Syddal Park have kindly agreed to rearrange our match against Racketeers B on 9th November, as the badminton courts at David Lloyd are currently out of action.

We haven’t agreed on a new date yet, but I’ll keep you posted once this has been confirmed.

Thanks for your help.

Emily`;

const DISLEY = `Hi

See below fixture change

Disley V Cheadle Hulme A
Original date - Tuesday 10th Nov 2026
New date - Tuesday 13th April 2027

Thanks

Nathan
Disley Badminton Club
Sent from my iPhone`;

const DOME = `Thanks everyone
________________________________
From: Stockport Badminton <results@example.invalid>
Sent: 13 October 2026 14:54
To: Tom <tom@example.invalid>
Subject: Re: Fixture date change, Dome

thanks all

website updated with the new date

Neil

On Tue, 13 Oct 2026 at 13:36, Tom <tom@example.invalid<mailto:tom@example.invalid>> wrote:
Hi Hannah,

The 10/02/27 looks like the best date to change it to for us.

Tom

On 13 Oct 2026, at 09:22, Rich <rich@example.invalid<mailto:rich@example.invalid>> wrote:

Hi Hannah

Tom is the captain for College Green C, he’ll be able to discuss rearranging.

On 13 Oct 2026, at 08:52, Hannah <hannah@example.invalid<mailto:hannah@example.invalid>> wrote:

Hi Richard

I was wondering if you'd be open to moving this fixture? currently scheduled for 25/11/2026. We have 2 matches on the same day and don't have enough players to field both teams. I can offer the following alternative dates.
04/11/2026
27/01/2027
10/02/2027

Thanks
Hannah`;

const SYDDAL_REFUSAL = `Thanks Chris. And yes, please keep me posted…..

On 2 Nov 2026, at 13:21, chris@example.invalid wrote:

Hi Ruth

Thanks for the update, we will keep working on trying to get a full team out for the fixture,  assume for now we will be there on the 8th.

From: Ruth
Sent: Monday, November 2, 2026 12:48 PM
To: chris@example.invalid
Cc: alderleyparkbc@example.invalid
Subject: Re: Fixture re-arrangement request Syddal Park B vs APBC B on 8th November

Good afternoon.

I have discussed with our committee and I’m afraid that we are unable to re-arrange the scheduled match on 8th November. We are already limited with court availability.

On 1 Nov 2026, at 09:00, chris@example.invalid wrote:

Hi Katie

I am contacting you for Alderley Park Badminton club B Team, to request if we can reschedule our match with Syddal B on the 8th of November, as we are currently struggling to field a team for the fixture.`;

const MELLOR_RELAY = `Hi,
I was wondering whether it would be possible to re-arrange the match that Mellor A have against you this coming Tuesday, 10th November, at your place.  We're struggling to get a team out.
Please let me know if this is possible.
Many Thanks, Roger, Mellor Match Secretary


From roger@example.invalid. Replying to this email goes back to them.`;

describe('readRearrangementEmail', () => {
  it('reads a postponement with no new date, and the clubs, despite the wrong team letter', () => {
    const r = read('9th Nov - Racketeers A v Syddal', RACKETEERS, '2026-11-02');
    assert.deepStrictEqual([...new Set(r.dates.map(d => d.ymd))], ['2026-11-09']);
    assert.ok([59, 41].every(id => r.clubIds.includes(id)));
    assert.strictEqual(r.noDateYet, true);
    assert.strictEqual(r.refused, false);
  });

  it('reads labelled original and new dates, checking the weekday given', () => {
    const r = read('Disley v Cheadle Hulme A', DISLEY, '2026-10-26');
    assert.deepStrictEqual(r.dates.map(d => [d.ymd, d.role, d.dayMismatch]), [
      ['2026-11-10', 'original', false], ['2027-04-13', 'new', false]]);
    assert.deepStrictEqual(r.clubIds.sort(), [49, 51]);
    assert.deepStrictEqual(r.teamIds, [31]);
    assert.strictEqual(r.noDateYet, false);
  });

  it('skips the dates in a thread\'s headers and reply lines, and keeps the rest in reading order', () => {
    const r = read('Re: Fixture date change, Dome', DOME, '2026-10-13');
    assert.deepStrictEqual(r.dates.map(d => d.ymd), ['2027-02-10', '2026-11-25', '2026-11-04', '2027-01-27', '2027-02-10']);
    assert.strictEqual(r.dates[1].role, 'original');
    assert.deepStrictEqual(r.clubIds.sort(), [52, 61]);
  });

  it('flags a refusal, and finds a club by its initials', () => {
    const r = read('Re: Fixture re-arrangement request Syddal Park B vs APBC B on 8th November', SYDDAL_REFUSAL, '2026-11-02');
    assert.strictEqual(r.refused, true);
    assert.deepStrictEqual(r.clubIds.sort(), [41, 43]);
    assert.deepStrictEqual([...new Set(r.dates.map(d => d.ymd))], ['2026-11-08']);
  });

  it('takes the writer from a contact-form relay\'s footer', () => {
    const r = read('Somebody is trying to get in touch', MELLOR_RELAY, '2026-11-04');
    assert.strictEqual(r.originalFrom, 'roger@example.invalid');
    assert.deepStrictEqual(r.dates.map(d => d.ymd), ['2026-11-10']);
    assert.deepStrictEqual(r.clubIds, [39]);
  });

  it('finds clubs however their names are punctuated or spaced', () => {
    const r = read('', 'GHAP v Parrswood on 3rd Dec', '2026-11-01');
    assert.deepStrictEqual(r.clubIds.sort(), [53, 57]);
    assert.deepStrictEqual(r.teamIds, []);
  });

  it('reads the date forms people write, and flags a weekday that does not match', () => {
    const r = read('', "moving it from Mon 9th Nov to Thursday 3rd of Feb '27, or 4.3.27, or March 10th", '2026-11-01');
    assert.deepStrictEqual(r.dates.map(d => [d.ymd, d.role]), [
      ['2026-11-09', 'original'], ['2027-02-03', 'new'], ['2027-03-04', null], ['2027-03-10', null]]);
    // 3 Feb 2027 is a Wednesday.
    assert.strictEqual(r.dates[1].dayMismatch, true);
  });

  it('puts a yearless date in the season the email arrived in', () => {
    assert.strictEqual(seasonYear(11, '2026-10-01'), 2026);
    assert.strictEqual(seasonYear(4, '2026-10-01'), 2027);
    assert.strictEqual(seasonYear(4, '2027-03-01'), 2027);
    assert.strictEqual(seasonYear(11, '2027-03-01'), 2026);
  });
});

describe('propose', () => {
  it('Racketeers: the 9 Nov fixture, not the club derby that is also waiting; no date', () => {
    const r = read('9th Nov - Racketeers A v Syddal', RACKETEERS, '2026-11-02');
    const p = propose(r, [
      fx(7147, '2026-10-05', 'Racketeers B', 'Racketeers A', 'rearranging'),
      fx(7124, '2026-11-09', 'Racketeers A', 'Syddal Park A'),
    ]);
    assert.deepStrictEqual(pick(p), { fixtureId: 7124, newDate: null });
  });

  it('Disley: the labelled new date', () => {
    const r = read('Disley v Cheadle Hulme A', DISLEY, '2026-10-26');
    assert.deepStrictEqual(pick(propose(r, [fx(7358, '2026-11-10', 'Disley A', 'Cheadle Hulme A')])), { fixtureId: 7358, newDate: '2027-04-13' });
  });

  it('Dome: the date in the newest reply, not the first one offered', () => {
    const r = read('Re: Fixture date change, Dome', DOME, '2026-10-13');
    assert.deepStrictEqual(pick(propose(r, [
      fx(7290, '2026-11-25', 'Dome B', 'College Green C'),
      fx(7254, '2026-11-25', 'Alderley Park B', 'College Green B'),
    ])), { fixtureId: 7290, newDate: '2027-02-10' });
  });

  it('Mellor: the fixture from one club and a date', () => {
    const r = read('Somebody is trying to get in touch', MELLOR_RELAY, '2026-11-04');
    assert.deepStrictEqual(pick(propose(r, [
      fx(7300, '2026-11-10', 'Aerospace A', 'Mellor A'),
      fx(7174, '2026-11-10', 'GHAP A', 'Racketeers B'),
    ])), { fixtureId: 7300, newDate: null });
  });

  it('proposes nothing when two fixtures are equally likely', () => {
    const r = read('', 'Our match on 10th November needs to move to 17th November', '2026-11-01');
    assert.deepStrictEqual(pick(propose(r, [
      fx(7300, '2026-11-10', 'Aerospace A', 'Mellor A'),
      fx(7174, '2026-11-10', 'GHAP A', 'Racketeers B'),
    ])), { fixtureId: null, newDate: '2026-11-17' });
  });

  it('a re-forwarded email does not offer to move the replacement a second time', () => {
    const r = read('Disley v Cheadle Hulme A', DISLEY, '2026-10-26');
    const p = propose(r, [
      fx(7358, '2026-11-10', 'Disley A', 'Cheadle Hulme A', 'rearranged'),
      fx(7695, '2027-04-13', 'Disley A', 'Cheadle Hulme A'),
    ]);
    assert.strictEqual(p.fixtureId, null);
  });

  it('counts the sender\'s club as named', () => {
    const r = read('', 'Can we move our match on 10th November to the 24th November please', '2026-11-01');
    const both = [fx(7300, '2026-11-10', 'Aerospace A', 'Mellor A'), fx(7174, '2026-11-10', 'GHAP A', 'Racketeers B')];
    assert.strictEqual(propose(r, both).fixtureId, null);
    assert.deepStrictEqual(pick(propose(r, both, [39])), { fixtureId: 7300, newDate: '2026-11-24' });
  });
});

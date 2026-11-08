// utils/registrationEmail.js — reading a forwarded registration email. Ported from
// Stockport's __tests__/unit/registration-email.test.js (jest there, node:test here), with
// their team names, since the parser is verbatim.
//
// Written by people, not forms, and forwarded, so the writer is inside the body. The
// reading is allowed to be imperfect (every line is shown, editable, beside the email on
// /admin/player-requests), but it must not miss the obvious list, which is the
// copying-and-pasting it replaces.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseRegistrationEmail, genderIn, asName } = require('../utils/registrationEmail');

const TEAMS = ['Dome A', 'Dome B', 'Shell A', 'Mellor A', 'Parrs Wood A'];
const read = (text, headerFrom) => parseRegistrationEmail({ text, headerFrom: headerFrom || 'Neil <neil@example.com>', teamNames: TEAMS });
const names = r => r.candidates.map(c => c.first + ' ' + c.family);

const GMAIL_FORWARD = [
  '---------- Forwarded message ---------',
  'From: Jane Secretary <jane@example.com>',
  'Date: Sun, 27 Sept 2026 at 19:02',
  'Subject: New players',
  'To: Neil <neil@example.com>',
  '',
  'Hi Neil,',
  '',
  'Could you please register the following for Dome B:',
  '',
  'Mary Whitle (F)',
  'John Smith - M',
  'Priya van der Berg, Female',
  '',
  'Thanks,',
  'Jane Secretary',
].join('\n');

describe('a forwarded list', () => {
  const r = read(GMAIL_FORWARD);

  it('finds who wrote it inside the forward, not the forwarder', () => {
    assert.strictEqual(r.originalFrom, 'Jane Secretary <jane@example.com>');
  });

  it('reads every name in the list, and nothing from the greeting or sign-off', () => {
    assert.deepStrictEqual(names(r), ['Mary Whitle', 'John Smith', 'Priya van der Berg']);
  });

  it('reads the gender each line gives, however it is written', () => {
    assert.deepStrictEqual(r.candidates.map(c => c.gender), ['Female', 'Male', 'Female']);
  });

  it('applies the one team the email names to the whole list', () => {
    assert.deepStrictEqual(r.candidates.map(c => c.team), ['Dome B', 'Dome B', 'Dome B']);
  });

  it('keeps the line each name came from, to show beside it', () => {
    assert.strictEqual(r.candidates[0].raw, 'Mary Whitle (F)');
  });
});

describe('other shapes', () => {
  it('reads a numbered, tab-separated table', () => {
    const r = read('Please add these to Parrs Wood A\n1. Tom Long\tMale\n2. Aimee Tsang\tFemale\n3) Chris O\'Brien\tM\n\nKind regards\nBob');
    assert.deepStrictEqual(names(r), ['Tom Long', 'Aimee Tsang', "Chris O'Brien"]);
    assert.deepStrictEqual(r.candidates.map(c => c.gender), ['Male', 'Female', 'Male']);
  });

  it('reads a player writing about themselves, in a sentence', () => {
    const r = read("Hi, I'd like to join the league. My name is Sarah Connor and I play for Shell A. Thanks! Sarah");
    assert.deepStrictEqual(names(r), ['Sarah Connor']);
    assert.strictEqual(r.candidates[0].team, 'Shell A');
  });

  // Excluding the sender's own name looked like the way to drop a sign-off, and would
  // have dropped exactly the player who writes in to register themselves.
  it('keeps the sender\'s own name when they are the one registering', () => {
    const r = read('Name: Ali Khan\nTeam: Mellor A\nGender: Male\n', '"Ali Khan" <ali@example.com>');
    assert.deepStrictEqual(names(r), ['Ali Khan']);
    assert.deepStrictEqual([r.candidates[0].gender, r.candidates[0].team], ['Male', 'Mellor A']);
  });

  it('attaches "Gender:" lines to the name above them', () => {
    const r = read('Name: Ali Khan\nGender: Male\n\nName: Sam Roe\nGender: Female\n');
    assert.deepStrictEqual(r.candidates.map(c => [c.first, c.gender]), [['Ali', 'Male'], ['Sam', 'Female']]);
  });

  it('stops at a quoted earlier message', () => {
    const r = read('Jo Bloggs F\n\nOn Tue, 1 Sep 2026, Someone <a@b.com> wrote:\n> Old Person\n');
    assert.deepStrictEqual(names(r), ['Jo Bloggs']);
  });

  it('stops at a signature', () => {
    const r = read('Jo Bloggs F\n-- \nBob Jones\nParrs Wood Badminton Club');
    assert.deepStrictEqual(names(r), ['Jo Bloggs']);
  });

  it('reads nothing from an email that names nobody', () => {
    assert.deepStrictEqual(read('Hi Neil,\n\nAre we still on for Tuesday?\n\nCheers\nBob').candidates, []);
  });

  it('lists each person once', () => {
    assert.deepStrictEqual(names(read('Mary Whitle F\nMary Whitle F\n')), ['Mary Whitle']);
  });

  it('leaves the team for the page to ask when the email names two', () => {
    const r = read('Mary Whitle F Dome A\nJo Bloggs F\nAlso for Shell A later\n');
    assert.deepStrictEqual(r.candidates.map(c => c.team), ['Dome A', null]);
    assert.deepStrictEqual(r.teams, ['Dome A', 'Shell A']);
  });
});

it('writes a capitalised surname as a name is written', () => {
  assert.deepStrictEqual(asName('Mary WHITLE'), { first: 'Mary', family: 'Whitle' });
  assert.deepStrictEqual(asName("SEAN O'BRIEN-SMITH"), { first: 'Sean', family: "O'Brien-Smith" });
});

describe('genderIn', () => {
  [
    ['Mary Whitle (F)', 'Female'],
    ['John Smith - M', 'Male'],
    ['Priya, ladies', 'Female'],
    ['Tom Fox', null],        // the F in Fox is not a gender
    ['Sam Mills', null],
    ["men's and ladies' teams", null],
  ].forEach(([line, want]) => it(`${line} -> ${want}`, () => {
    assert.strictEqual(genderIn(line), want);
  }));
});

describe('asName', () => {
  [
    ['Mary Whitle', true],
    ['Priya van der Berg', true],
    ["Chris O'Brien", true],
    ['Hi Neil', false],
    ['Kind Regards', false],
    ['New Players', false],
    ['Dome B', false],        // a team, not a surname
    ['KIND REGARDS', false],
    ['Mary Whitle F', true],
    ['Tom Long Male', true],
    ['mary whitle', false],
    ['Mary', false],
  ].forEach(([s, ok]) => it(`${s} -> ${ok}`, () => {
    assert.strictEqual(!!asName(s), ok);
  }));
});

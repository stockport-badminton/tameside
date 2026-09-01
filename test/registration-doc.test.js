// Reading a club's returned registration form.
//
// The .docx fixture is BUILT HERE with the same `docx` package that generates the real
// one (controllers/playerController.js), rather than committing a binary: it exercises the
// genuine zip + WordprocessingML path, and it cannot drift from the generator the way a
// checked-in sample would. The structure it builds is the one measured across all seven
// real returned files, whose row shapes were identical:
//
//   1 cell  -> "<Club> Registrations", then "<Club> A", "<Club> B", ... per team block
//   2 cells -> "Men | Ladies"
//   4 cells -> "<man> | <letter> | <lady> | <letter>",  letter being A/B/C... or 'R'

const { describe, it } = require('node:test');
const assert = require('node:assert');
const docx = require('docx');

const {
  parseRegistrationDocument, parseRegistrationDocx, readLetterCell, docxCellText,
} = require('../utils/registrationDoc');

const cell = (text, pct) => new docx.TableCell({
  children: [new docx.Paragraph(String(text))],
  width: { size: pct, type: docx.PERCENTAGE },
});
const trow = (cells) => new docx.TableRow({ children: cells });

async function buildDocx(club, blocks) {
  const rows = [trow([cell(club + ' Registrations', 100)])];
  for (const b of blocks) {
    rows.push(trow([cell(club + ' ' + b.letter, 100)]));
    rows.push(trow([cell('Men', 50), cell('Ladies', 50)]));
    for (const r of b.rows) {
      rows.push(trow([cell(r[0], 40), cell(r[1], 10), cell(r[2], 40), cell(r[3], 10)]));
    }
  }
  const doc = new docx.Document({ sections: [{ children: [new docx.Table({ rows })] }] });
  return docx.Packer.toBuffer(doc);
}

const HYDE = [
  { letter: 'A', rows: [
    ['Andrew Capewell', 'A', 'Alice Cooper', 'A'],
    ['David Kennon',    'A', '',             'R'],
    ['Gareth Perrins',  'R', '',             'R'],
  ] },
  { letter: 'B', rows: [
    ['Neil Cooper',  'B', 'Jill Jackson', 'B'],
    ['Dave Lee',     'R', '',             'R'],
  ] },
];

describe('parsing the .docx a club returns', () => {
  it('reads the club name out of the document, not the filename', async () => {
    // Taken from the document so a file sent for the wrong club can be CAUGHT rather than
    // applied to whichever club happened to be selected in the form.
    const parsed = await parseRegistrationDocx(await buildDocx('Hyde', HYDE));
    assert.strictEqual(parsed.club, 'Hyde');
    assert.strictEqual(parsed.source, 'docx');
  });

  it('reads every named player and ignores the padding rows', async () => {
    const parsed = await parseRegistrationDocx(await buildDocx('Hyde', HYDE));
    assert.deepStrictEqual(parsed.entries.map(e => e.name), [
      'Andrew Capewell', 'Alice Cooper', 'David Kennon', 'Gareth Perrins',
      'Neil Cooper', 'Jill Jackson', 'Dave Lee',
    ]);
    assert.deepStrictEqual(parsed.warnings, []);
  });

  it('gets gender from the column, which is the only place it is stated', async () => {
    const parsed = await parseRegistrationDocx(await buildDocx('Hyde', HYDE));
    const g = Object.fromEntries(parsed.entries.map(e => [e.name, e.gender]));
    assert.strictEqual(g['Andrew Capewell'], 'Male');
    assert.strictEqual(g['Alice Cooper'], 'Female');
    assert.strictEqual(g['Jill Jackson'], 'Female');
  });

  it('treats R as a reserve and keeps the block it was listed under', async () => {
    // The letter column says 'R', so the block heading is the only record of which team a
    // reserve belongs to -- and the database does keep a team for reserves.
    const parsed = await parseRegistrationDocx(await buildDocx('Hyde', HYDE));
    const gareth = parsed.entries.find(e => e.name === 'Gareth Perrins');
    assert.strictEqual(gareth.reserve, true);
    assert.strictEqual(gareth.teamLetter, null);
    assert.strictEqual(gareth.block, 'A');
    assert.strictEqual(parsed.entries.find(e => e.name === 'Dave Lee').block, 'B');
  });

  it('preserves document order, because row order IS the batting order', async () => {
    const parsed = await parseRegistrationDocx(await buildDocx('Hyde', HYDE));
    const men = parsed.entries.filter(e => e.gender === 'Male' && !e.reserve).map(e => e.name);
    assert.deepStrictEqual(men, ['Andrew Capewell', 'David Kennon', 'Neil Cooper']);
  });

  it('survives Word splitting a name into several runs', () => {
    // Word breaks a <w:t> wherever formatting changes, so a partly re-typed or
    // spell-checked name arrives in pieces. Concatenating every run in order is the only
    // way to get the string back.
    const split = '<w:tc><w:p><w:r><w:t>Andrew</w:t></w:r>'
      + '<w:r><w:t xml:space="preserve"> Cape</w:t></w:r>'
      + '<w:r><w:t>well</w:t></w:r></w:p></w:tc>';
    assert.strictEqual(docxCellText(split), 'Andrew Capewell');
  });

  it('decodes XML entities in a name', () => {
    assert.strictEqual(docxCellText('<w:t>O&apos;Brien &amp; Sons</w:t>'), "O'Brien & Sons");
  });
});

describe('reading the team/reserve column', () => {
  it('accepts the letter as written', () => {
    assert.strictEqual(readLetterCell('B').teamLetter, 'B');
    assert.strictEqual(readLetterCell('B').reserve, false);
  });

  it('accepts what a captain might actually type for a reserve', () => {
    for (const v of ['R', 'r', 'Res', 'res', 'Reserve', 'reserve']) {
      assert.strictEqual(readLetterCell(v).reserve, true, v);
    }
  });

  it('accepts a full team name pasted into the letter cell', () => {
    assert.strictEqual(readLetterCell('Hyde B').teamLetter, 'B');
  });

  it('reports an unreadable cell rather than guessing a team', () => {
    assert.strictEqual(readLetterCell('').unreadable, true);
    assert.strictEqual(readLetterCell('??').unreadable, true);
  });
});

describe('deciding which parser to use', () => {
  it('dispatches on the file contents, not the extension', async () => {
    // A .docx renamed .pdf is a normal thing to receive from a club.
    const parsed = await parseRegistrationDocument(await buildDocx('Hyde', HYDE), 'Hyde.pdf');
    assert.strictEqual(parsed.source, 'docx');
  });

  it('rejects something that is neither, with a 400 rather than a 500', async () => {
    await assert.rejects(
      () => parseRegistrationDocument(Buffer.from('just some text, maybe an email'), 'notes.txt'),
      (err) => err.status === 400 && /Could not tell what kind of file/.test(err.message));
  });

  it('rejects an empty upload', async () => {
    await assert.rejects(() => parseRegistrationDocument(Buffer.alloc(0), 'x.docx'),
      (err) => err.status === 400);
  });

  it('rejects a zip that is not a Word document', async () => {
    // 'PK' magic but no word/document.xml.
    const notWord = Buffer.concat([Buffer.from('PK'), Buffer.alloc(64)]);
    await assert.rejects(() => parseRegistrationDocument(notWord, 'x.zip'),
      (err) => err.status === 400);
  });
});

describe('warnings rather than silent guesses', () => {
  it('says so when the document names no club', async () => {
    // With no club name the "<Club> Registrations" heading cannot be recognised.
    const parsed = await parseRegistrationDocx(
      await buildDocx('', [{ letter: 'A', rows: [['Bob Smith', 'A', '', 'R']] }]));
    assert.ok(parsed.warnings.some(w => /did not name a club/.test(w)), parsed.warnings.join('; '));
  });

  it('warns, and falls back to reserve, on an unreadable team column', async () => {
    const parsed = await parseRegistrationDocx(
      await buildDocx('Hyde', [{ letter: 'A', rows: [['Bob Smith', '??', '', 'R']] }]));
    assert.ok(parsed.warnings.some(w => /Bob Smith/.test(w)), parsed.warnings.join('; '));
    assert.strictEqual(parsed.entries[0].reserve, true);
  });
});

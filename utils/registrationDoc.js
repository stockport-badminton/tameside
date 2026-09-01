// Reading a club's returned team-registration form back into structured data.
//
// The league sends each club a pre-filled registration form, the club edits it and sends
// it back, and until now someone compared it against the management UI by eye. This
// module is the "read it" half of automating that; utils/registrationDiff.js is the
// "what changed" half.
//
// TWO FORMATS, because clubs return both:
//
//   .docx  — an edited copy of the file controllers/playerController.js generates and
//            views/team-admin.ejs links to. One table, and a very regular one.
//   .pdf   — the AcroForm at static/docs/Team Registration.pdf, filled in, as generated
//            by controllers/documentsController.js.
//
// Both reduce to the same shape, so the diff never has to care which arrived:
//
//   { club, source, entries: [ { name, gender, teamLetter, reserve, block, row } ], warnings }
//
// `teamLetter` is the letter the club has put this player against — 'A', 'B', … — or null
// when they wrote 'R'. `reserve` is that same fact as a boolean, because 'R' is what the
// form uses and rank 99 is what the database uses, and conflating the two is how the
// mapping goes wrong. `block` is the team heading the player was listed under, which is
// NOT the same as `teamLetter`: the form lists reserves under whichever team block they
// happen to sit in, and it is the letter column that is authoritative.
//
// WHAT THIS MODULE WILL NOT DO: it does not resolve a name to a player, and it does not
// decide anything. A name here is a string a captain typed. Everything downstream treats
// it as untrusted.

// jszip rather than a new zip dependency: it is already in the tree as the engine
// behind the `docx` package this repo uses to GENERATE these files, so declaring it in
// package.json adds a name but downloads nothing. A .docx is just a zip.
const JSZip = require('jszip');
const { PDFDocument } = require('pdf-lib');

// The generated .docx is one table whose rows come in three widths, and the width is
// what identifies the row. Measured across all seven returned files (Aerospace, College
// Green, GHAP, Hyde, Hyde High, Medlock, Mellor) — the shape was identical in every one:
//
//   1 cell  -> "<Club> Registrations", then "<Club> A", "<Club> B", … per team block
//   2 cells -> "Men | Ladies" column header, once per block
//   4 cells -> "<man's name> | <letter> | <lady's name> | <letter>"
//
// Both name cells of a 4-cell row can be blank (the generator pads the shorter gender's
// column), and a blank name with a letter in the next cell is padding rather than data.
const DOCX_ENTRY_CELLS = 4;

// Word stores runs of text as separate <w:t> elements and splits them wherever
// formatting changes, so a name a captain has partly re-typed or spell-checked arrives in
// pieces: "Andrew" + " " + "Capewell", sometimes mid-word. Concatenating every <w:t> in
// the cell in document order is the only reliable way to get the string back, which is
// why this does not try to match a single tag.
//
// Deliberately a regex over the XML rather than a DOM parse. The document body is one
// flat table, the cell and row delimiters are unambiguous, and pulling in an XML parser
// to walk three levels earns nothing. If the shape ever stops being a flat table this
// should become a real parse rather than a cleverer regex.
function docxCellText(cellXml) {
  const parts = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(cellXml)) !== null) parts.push(m[1] || '');
  return decodeXmlEntities(parts.join(''));
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

// Whitespace only. Names are compared and stored elsewhere; normalising case or
// punctuation here would throw away the club's own spelling before anyone has seen it.
function tidy(s) {
  // \u00a0 spelled as an escape, not as the literal character: a bare non-breaking
  // space in a regex is invisible in every editor and diff. Word emits them freely.
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

// 'A' … 'Z', or null for a reserve. Accepts what a captain might plausibly type in a
// one-character column: 'R', 'r', 'Res', 'Reserve', and the letter with or without the
// club name in front of it ("Hyde B" pasted into the letter cell has been seen).
function readLetterCell(raw, blockLetter) {
  const v = tidy(raw);
  if (!v) return { teamLetter: null, reserve: false, unreadable: true };
  if (/^r(es(erve)?)?$/i.test(v)) return { teamLetter: null, reserve: true };
  // A bare letter, or the last letter of something like "Hyde B".
  const m = /([A-Za-z])\s*$/.exec(v);
  if (m && /^[A-Za-z]$/.test(m[1])) {
    return { teamLetter: m[1].toUpperCase(), reserve: false, blockLetter };
  }
  return { teamLetter: null, reserve: false, unreadable: true };
}

// "Hyde A" -> "A"; "Hyde Registrations" -> null. Used only for `block`.
function blockLetterFrom(heading, club) {
  const h = tidy(heading);
  if (!club) return null;
  const rest = tidy(h.slice(club.length));
  return /^[A-Za-z]$/.test(rest) ? rest.toUpperCase() : null;
}

/**
 * Parse the .docx a club returns (an edited copy of the one we generate).
 * Buffer in, canonical shape out. Throws only if the file is not a readable docx.
 */
async function parseRegistrationDocx(buffer) {
  let xml;
  try {
    const zip = await JSZip.loadAsync(buffer);
    const part = zip.file('word/document.xml');
    xml = part ? await part.async('string') : null;
  } catch (err) {
    const e = new Error('That file is not a readable Word document.');
    e.status = 400;
    throw e;
  }
  if (!xml) {
    const e = new Error('That Word document has no readable content.');
    e.status = 400;
    throw e;
  }

  const warnings = [];
  const entries = [];
  let club = null;
  let block = null;

  // Rows in document order; cells within each row in document order.
  const rows = xml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || [];
  for (const rowXml of rows) {
    const cells = (rowXml.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || []).map(docxCellText);

    if (cells.length === 1) {
      const heading = tidy(cells[0]);
      if (/registrations$/i.test(heading)) {
        // "Hyde Registrations" — the club name is everything before it. Taken from the
        // document rather than from the upload form, so a file sent for the wrong club
        // can be caught rather than applied to whichever club was selected.
        club = tidy(heading.replace(/registrations$/i, ''));
      } else if (heading) {
        block = blockLetterFrom(heading, club) || block;
      }
      continue;
    }

    if (cells.length !== DOCX_ENTRY_CELLS) continue; // "Men | Ladies" header, or noise

    // Column order is fixed by the generator: men first, then ladies.
    addEntry(entries, warnings, cells[0], cells[1], 'Male', block);
    addEntry(entries, warnings, cells[2], cells[3], 'Female', block);
  }

  if (!club) warnings.push('The document did not name a club, so its club could not be checked.');
  if (!entries.length) warnings.push('No player rows were found in the document.');

  return { club, source: 'docx', entries, warnings };
}

function addEntry(entries, warnings, nameCell, letterCell, gender, block) {
  const name = tidy(nameCell);
  if (!name) return; // padding row for the shorter gender column
  const { teamLetter, reserve, unreadable } = readLetterCell(letterCell, block);
  if (unreadable) {
    warnings.push(`Could not read the team column for "${name}" (found "${tidy(letterCell)}") — treated as a reserve.`);
  }
  entries.push({
    name, gender,
    teamLetter: teamLetter || null,
    reserve: reserve || !teamLetter,
    block: block || null,
    row: entries.length,
  });
}

// --- PDF ------------------------------------------------------------------
//
// The AcroForm has two kinds of field, and only the first is self-describing:
//
//   `Ladies<L>` / `MenOpen<L>`, plus `_2`..`_5` for rows 2-5 — the fixed A-D nominated
//   blocks. The field NAME carries gender, team letter and row, so these need no
//   geometry and are read directly.
//
//   `Dyn_<n>` — created at fill time for the reserves table and any nominated overflow
//   (documentsController.makeRenderer). The name carries only a counter, so the column a
//   value belongs to has to be recovered from where the widget sits on the page. That is
//   why this reads the widget rectangle rather than trusting the counter: the counter's
//   meaning depends on how many rows the generator happened to draw, which depends on the
//   club, so `Dyn_7` is a different column for a two-team club than a four-team one.
//
// Reserve rows are [Team, Ladies, Team, Men/Open] and overflow rows are
// [Team, Ladies, Men/Open], and the two tables use different x positions, so the x of the
// widget identifies the column within a row and the y groups widgets into rows.
const NOMINATED_FIELD = /^(Ladies|MenOpen)([A-Z])(?:_(\d+))?$/;

// Column x-origins from documentsController's RES_COLS / NOM_COLS. Matched with a
// tolerance because pdf-lib writes the rect back as a float.
const X_TOLERANCE = 6;
const RES_X = { team1: 38.3, ladies: 89.9, team2: 321.4, men: 373.2 };
const NOM_X = { team: 38.3, ladies: 89.9, men: 321.4 };
const near = (a, b) => Math.abs(a - b) <= X_TOLERANCE;

function parseRegistrationPdfSync(form, pages) {
  const warnings = [];
  const entries = [];
  let club = null;

  const text = name => {
    try { return tidy(form.getTextField(name).getText()); } catch (e) { return ''; }
  };
  club = text('Club Name') || null;

  // 1. The fixed, self-describing nominated blocks.
  const nominated = [];
  for (const field of form.getFields()) {
    const m = NOMINATED_FIELD.exec(field.getName());
    if (!m) continue;
    const name = text(field.getName());
    if (!name) continue;
    nominated.push({
      name,
      gender: m[1] === 'Ladies' ? 'Female' : 'Male',
      teamLetter: m[2],
      reserve: false,
      block: m[2],
      // Row 1 is the bare field, rows 2-5 carry _2.._5.
      sortKey: [m[2], m[1], m[3] ? Number(m[3]) : 1],
    });
  }
  nominated.sort((a, b) =>
    a.sortKey[0].localeCompare(b.sortKey[0]) ||
    a.sortKey[1].localeCompare(b.sortKey[1]) ||
    a.sortKey[2] - b.sortKey[2]);

  // 2. The positional Dyn_ fields, grouped into rows by y within each page.
  const pageIndex = new Map(pages.map((p, i) => [p.ref.toString(), i]));
  const dyn = [];
  for (const field of form.getFields()) {
    if (!/^Dyn_\d+$/.test(field.getName())) continue;
    const value = text(field.getName());
    for (const widget of field.acroField.getWidgets()) {
      const rect = widget.getRectangle();
      const pageRef = widget.P();
      dyn.push({
        value,
        page: pageRef ? (pageIndex.get(pageRef.toString()) ?? 0) : 0,
        x: rect.x, y: rect.y,
      });
    }
  }

  // Group by page then by y (a row), highest y first — PDF y grows upward.
  const byRow = new Map();
  for (const w of dyn) {
    const key = `${w.page}:${Math.round(w.y)}`;
    (byRow.get(key) || byRow.set(key, []).get(key)).push(w);
  }
  const rowKeys = [...byRow.keys()].sort((a, b) => {
    const [pa, ya] = a.split(':').map(Number), [pb, yb] = b.split(':').map(Number);
    return pa - pb || yb - ya;
  });

  for (const key of rowKeys) {
    const cells = byRow.get(key).sort((a, b) => a.x - b.x);
    const at = xs => cells.find(c => near(c.x, xs));

    // A reserves row has FOUR x positions; an overflow row has three, and its men
    // column sits at the reserves table's second Team x. So the four-column case must be
    // tested first, and by the presence of the men column at 373.2.
    // IMPORTANT: the two dynamic tables encode reserve-ness differently from the .docx,
    // and differently from each other. The .docx writes 'R' in the letter column; the PDF
    // does not — documentsController's reserveRows() puts the player's CURRENT TEAM
    // LETTER in the reserves table's Team cell. So in a PDF, reserve-ness comes from
    // WHICH TABLE the row is in, never from the letter, and reading the letter as
    // nominated would silently promote every reserve in the club.
    //
    // The reserves table has four columns (Team, Ladies, Team, Men/Open) and the
    // nominated-overflow table three (Team, Ladies, Men/Open). They are told apart by the
    // men column: only the reserves table puts one at RES_X.men (373.2), and the overflow
    // table's men column sits at 321.4, which is the reserves table's *second Team* x.
    // So the four-column case must be tested first.
    const resMen = at(RES_X.men);
    if (resMen) {
      const la = at(RES_X.ladies), lt = at(RES_X.team1);
      const mt = at(RES_X.team2);
      if (la && tidy(la.value)) pushPositional(entries, warnings, la.value, lt && lt.value, 'Female', true);
      if (tidy(resMen.value)) pushPositional(entries, warnings, resMen.value, mt && mt.value, 'Male', true);
      continue;
    }
    const nomMen = at(NOM_X.men), nomLadies = at(NOM_X.ladies), nomTeam = at(NOM_X.team);
    if (nomLadies || nomMen) {
      const letter = nomTeam && tidy(nomTeam.value);
      if (nomLadies && tidy(nomLadies.value)) pushPositional(entries, warnings, nomLadies.value, letter, 'Female', false);
      if (nomMen && tidy(nomMen.value)) pushPositional(entries, warnings, nomMen.value, letter, 'Male', false);
    }
  }

  // Nominated first (they carry an explicit order), then the positional rows in the
  // order they appear on the page.
  const all = [...nominated, ...entries].map((e, i) => ({
    name: e.name, gender: e.gender,
    teamLetter: e.teamLetter || null,
    reserve: e.reserve === undefined ? !e.teamLetter : e.reserve,
    block: e.block || null,
    row: i,
  }));

  if (!club) warnings.push('The form did not name a club, so its club could not be checked.');
  if (!all.length) warnings.push('No player rows were found in the form.');
  return { club, source: 'pdf', entries: all, warnings };
}

// `isReserve` is decided by the caller from which table the row came out of, NOT from the
// letter — see the comment at the call site. The letter is still read, because for a
// reserve it names the team the player sits under, which is the team the database keeps
// for them alongside rank 99.
function pushPositional(entries, warnings, nameCell, letterCell, gender, isReserve) {
  const name = tidy(nameCell);
  if (!name) return;
  const raw = tidy(letterCell);
  const { teamLetter, unreadable } = readLetterCell(raw || 'R', null);
  if (raw && unreadable) {
    warnings.push(`Could not read the team column for "${name}" (found "${raw}").`);
  }
  entries.push({
    name, gender,
    // A nominated row with no readable letter has no team; a reserve without one keeps
    // null and the diff will ask for it rather than guessing.
    teamLetter: teamLetter || null,
    reserve: isReserve,
    block: teamLetter || null,
  });
}

async function parseRegistrationPdf(buffer) {
  let doc;
  try {
    doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch (err) {
    const e = new Error('That file is not a readable PDF.');
    e.status = 400;
    throw e;
  }
  let form;
  try {
    form = doc.getForm();
  } catch (err) {
    const e = new Error('That PDF has no form fields — it may be a scan or a printed copy.');
    e.status = 400;
    throw e;
  }
  return parseRegistrationPdfSync(form, doc.getPages());
}

// Dispatch on what the bytes actually are, not on the filename. A .docx renamed to .pdf
// (or the reverse) is a normal thing to receive from a club, and the magic bytes are
// unambiguous: both are ZIPs vs `%PDF`.
async function parseRegistrationDocument(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    const e = new Error('That file is empty.');
    e.status = 400;
    throw e;
  }
  const head = buffer.subarray(0, 4).toString('latin1');
  if (head === '%PDF') return parseRegistrationPdf(buffer);
  if (head.startsWith('PK')) return parseRegistrationDocx(buffer);
  const e = new Error(
    `Could not tell what kind of file "${filename || 'that'}" is — expected the Word or PDF registration form.`);
  e.status = 400;
  throw e;
}

module.exports = {
  parseRegistrationDocument,
  parseRegistrationDocx,
  parseRegistrationPdf,
  // exported for tests
  readLetterCell,
  docxCellText,
  tidy,
};

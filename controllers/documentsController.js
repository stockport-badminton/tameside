const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const Player = require('../models/players');

// The fillable AcroForm template (static/docs/Team Registration.pdf). Its
// header/intro/branding are baked in; we only populate the form fields.
const TEAM_REGISTRATION_TEMPLATE = path.join(__dirname, '../static/docs/Team Registration.pdf');
const CLUB_CLAIM = 'https://my-app.example.com/club';

// Tameside's roster query is callback-style (models/players.js) — promisify it.
const getRoster = club => new Promise((resolve, reject) =>
  Player.getNamesClubsTeams({ club }, (err, rows) => err ? reject(err) : resolve(rows || [])));

// Team names are "<Club> A" / "<Club> B" — the fixed tables and Team columns
// show just the distinguishing letter.
const teamLetter = teamName => String(teamName || '').trim().slice(-1).toUpperCase();

// Names come from concat(first_name,' ',family_name) over padded columns, so
// they can carry doubled/edge whitespace ("Alice  Cooper") — tidy for display.
const cleanName = name => String(name || '').replace(/\s+/g, ' ').trim();

function setField(form, name, value) {
  try {
    form.getTextField(name).setText(value || '');
  } catch (e) {
    // Field absent from this template revision — skip rather than 500.
    console.warn(`Team registration form: no field "${name}"`);
  }
}

// --- Static template field names -------------------------------------
//
// Nominated (Team Registration) table: four fixed 5-row blocks keyed by team
// letter. Row 1 is "Ladies<L>"/"MenOpen<L>"; rows 2..5 add "_<n>".
const STATIC_LETTERS = ['A', 'B', 'C', 'D'];
const NOMINATED_ROWS = 5;
function nominatedField(gender, letter, rowIndex) {
  const base = (gender === 'Female' ? 'Ladies' : 'MenOpen') + letter;
  return rowIndex === 0 ? base : `${base}_${rowIndex + 1}`;
}

// Splits a club's players into per-letter nominated ladies/men and pooled
// reserve ladies/men, each rank-ordered. NB: player.rank comes back from
// postgres.js as a string ("99"), so coerce before the reserve test.
function organiseRoster(rows) {
  const byRank = (a, b) => Number(a.rank) - Number(b.rank);
  const nominated = rows.filter(r => Number(r.rank) !== 99);
  const reserves = rows.filter(r => Number(r.rank) === 99);

  const teamLadies = {}, teamMen = {};
  nominated.forEach(r => {
    const bucket = r.gender === 'Female' ? teamLadies : teamMen;
    const L = teamLetter(r.teamName);
    (bucket[L] = bucket[L] || []).push(r);
  });
  Object.values(teamLadies).forEach(a => a.sort(byRank));
  Object.values(teamMen).forEach(a => a.sort(byRank));

  return {
    teamLadies, teamMen,
    resLadies: reserves.filter(r => r.gender === 'Female'),
    resMen: reserves.filter(r => r.gender === 'Male'),
    // Every distinct team letter present, so overflow letters beyond A-D are
    // still handled on the continuation page rather than silently dropped.
    letters: Array.from(new Set(nominated.map(r => teamLetter(r.teamName)))).sort(),
  };
}

// --- Dynamically-drawn tables ----------------------------------------
//
// Used for (a) the reserves table, redrawn with a Team column for BOTH genders
// (the template only has one, on the left — see reserves handling below), and
// (b) nominated/overflow continuation pages when a club exceeds the template's
// fixed capacity. Fields created here are real, editable AcroForm text fields.
const PAGE_SIZE = [595.2, 841.68];
const NAVY = rgb(0.043, 0.176, 0.427);
const WHITE = rgb(1, 1, 1);
const TOP_Y = 800, BOTTOM_Y = 40, HEADER_H = 17, ROW_H = 14.5, FIELD_H = 13;

// Column specs (x / width in PDF points). The reserves columns reuse the
// template's own Team?/Ladies x-positions and split the wide Men/Open column
// into a narrow Team cell + the name, so the redraw lines up with the header.
const RES_COLS = [
  { header: 'Team', x: 38.3, w: 49.8 },
  { header: 'Ladies', x: 89.9, w: 229.7 },
  { header: 'Team', x: 321.4, w: 49.8 },
  { header: 'Men/Open', x: 373.2, w: 180.2 },
];
const NOM_COLS = [
  { header: 'Team', x: 38.3, w: 49.8 },
  { header: 'Ladies', x: 89.9, w: 229.7 },
  { header: 'Men/Open', x: 321.4, w: 232.0 },
];

function makeRenderer(doc, form, font) {
  let page = null, y = 0, counter = 0;
  const freshPage = () => { page = doc.addPage(PAGE_SIZE); y = TOP_Y; };
  const drawHeader = cols => {
    cols.forEach(c => {
      page.drawRectangle({ x: c.x, y: y - HEADER_H, width: c.w, height: HEADER_H, color: NAVY });
      page.drawText(c.header, { x: c.x + 4, y: y - HEADER_H + 5, size: 8, font, color: WHITE });
    });
    y -= HEADER_H;
  };
  const drawField = (x, w, value) => {
    const f = form.createTextField(`Dyn_${counter++}`);
    f.setText(value || '');
    f.addToPage(page, { x, y: y - FIELD_H, width: w, height: FIELD_H, borderWidth: 0.5, borderColor: rgb(0, 0, 0) });
  };
  return {
    // Position the cursor on an existing page (e.g. the template's page 2).
    at(existingPage, startY) { page = existingPage; y = startY; },
    // Force the next section/rows onto a fresh page (keeps sections that must
    // not share a page — e.g. reserves vs. a nominated continuation — apart).
    pageBreak() { page = null; },
    header: drawHeader,
    rows(cols, rows) {
      rows.forEach(vals => {
        if (!page || y - ROW_H < BOTTOM_Y) { freshPage(); drawHeader(cols); }
        cols.forEach((c, i) => drawField(c.x, c.w, vals[i]));
        y -= ROW_H;
      });
    },
    section(title, cols, rows) {
      if (!page || y - (26 + HEADER_H + ROW_H) < BOTTOM_Y) freshPage();
      page.drawText(title, { x: cols[0].x, y: y - 12, size: 13, font, color: NAVY });
      y -= 26;
      drawHeader(cols);
      this.rows(cols, rows);
    },
  };
}

// Pairs ladies/men into rows one team-letter at a time, so each row's lady and
// man share a team where possible and every cell carries its own team letter.
// Returns [teamLadies, ladyName, teamMen, manName] value arrays for RES_COLS.
function reserveRows(ladies, men) {
  const letters = Array.from(new Set(
    [...ladies, ...men].map(p => teamLetter(p.teamName))
  )).sort();
  const rows = [];
  letters.forEach(L => {
    const la = ladies.filter(p => teamLetter(p.teamName) === L);
    const me = men.filter(p => teamLetter(p.teamName) === L);
    for (let i = 0; i < Math.max(la.length, me.length); i++) {
      rows.push([
        la[i] ? L : '', la[i] ? cleanName(la[i].name) : '',
        me[i] ? L : '', me[i] ? cleanName(me[i].name) : '',
      ]);
    }
  });
  return rows;
}

// Nominated players beyond the template's fixed rows, paired by row and tagged
// with the team letter. Returns [team, ladyName, manName] arrays for NOM_COLS.
function nominatedOverflowRows(letter, ladies, men, limit) {
  const oL = (ladies || []).slice(limit), oM = (men || []).slice(limit);
  const rows = [];
  for (let i = 0; i < Math.max(oL.length, oM.length); i++) {
    rows.push([letter, oL[i] && cleanName(oL[i].name), oM[i] && cleanName(oM[i].name)]);
  }
  return rows;
}

// A captain may only generate their own club's form; the "All" claim (superadmin)
// may generate any. Returns true if allowed.
function hasClubAccess(req, club) {
  const userClub = req.user && req.user._json && req.user._json[CLUB_CLAIM];
  return userClub === club || userClub === 'All';
}

exports.teamRegistrationFormPrefilled = async function(req, res, next) {
  try {
    const club = req.params.club;
    // Expected conditions (access, unknown club) answer directly rather than
    // via next(err), so they don't get logged as 500s / reported to Sentry.
    if (!hasClubAccess(req, club)) {
      return res.status(403).send("Sorry, you don't have access to this club's registration form.");
    }

    const roster = await getRoster(club);
    if (roster.length < 1) {
      return res.status(404).send(`No player registrations found for a club named "${club}".`);
    }
    const { teamLadies, teamMen, resLadies, resMen, letters } = organiseRoster(roster);

    const doc = await PDFDocument.load(fs.readFileSync(TEAM_REGISTRATION_TEMPLATE));
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const render = makeRenderer(doc, form, font);

    setField(form, 'Club Name', club);

    // Fill the fixed A-D nominated blocks (5 rows each).
    STATIC_LETTERS.forEach(letter => {
      const ladies = teamLadies[letter] || [], men = teamMen[letter] || [];
      for (let i = 0; i < NOMINATED_ROWS; i++) {
        setField(form, nominatedField('Female', letter, i), ladies[i] && cleanName(ladies[i].name));
        setField(form, nominatedField('Male', letter, i), men[i] && cleanName(men[i].name));
      }
    });

    // Reserves: the template's static table has a single left-hand Team column,
    // but pooled reserve ladies and men are different people with different team
    // allegiances. Blank that table and redraw it with a Team column for each
    // gender, populated with the player's current team letter.
    const page2 = doc.getPages()[1];
    page2.drawRectangle({ x: 34, y: 503, width: 524, height: 200, color: WHITE });
    render.at(page2, 700);
    render.header(RES_COLS);
    render.rows(RES_COLS, reserveRows(resLadies, resMen));

    // Nominated overflow (clubs exceeding 5 per team/gender) spills onto
    // continuation page(s).
    const nominatedOverflow = [];
    letters.forEach(letter => {
      const limit = STATIC_LETTERS.includes(letter) ? NOMINATED_ROWS : 0;
      nominatedOverflow.push(...nominatedOverflowRows(letter, teamLadies[letter], teamMen[letter], limit));
    });
    if (nominatedOverflow.length) {
      console.warn(`Team registration form: nominated overflow for club "${club}" (+${nominatedOverflow.length})`);
      render.pageBreak(); // start on a fresh page, after the reserves table
      render.section('Team Registration (continued)', NOM_COLS, nominatedOverflow);
    }

    const pdfBytes = await doc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${club} Team Registration.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    next(err);
  }
};

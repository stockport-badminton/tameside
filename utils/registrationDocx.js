// The club's team registration form, as a Word document.
//
// This used to live inline in playerController.manage_player_list_clubs_teams, which
// built the document as a SIDE EFFECT of rendering the team-admin page and wrote it to
// `static/docs/<name>.docx` with fs.writeFileSync — so the "Download" link on that page
// only worked if somebody had loaded the page first, on that container, and the
// generated files kept turning up as untracked changes in git.
//
// It is here because the registration chase email attaches the same document, and an
// email cannot wait for someone to visit a page. `build()` returns a Buffer; nothing in
// this file touches the filesystem. The team-admin page keeps writing its copy, from
// this same builder, so the two can never disagree about what a club is sent.
//
// THE FORMAT IS A CONTRACT. utils/registrationDoc.js parses these documents back when a
// club returns one, and utils/registrationDiff.js turns that into changes. In particular:
//
//   - the letter column is the data model: A/B/C means nominated for that team, R means
//     reserve. The .docx writes `R` for a reserve; the PDF does not (see CLAUDE.md).
//   - row order within a team block IS the rank order. There is no rank column.
//   - a reserve's team comes from the block heading, nowhere else.
//
// So a change to the table shape here is a change to what the import screen reads.

const docx = require('docx');
const jp = require('jsonpath');

const CELL_MARGINS = {
  top: docx.convertInchesToTwip(0.05),
  bottom: docx.convertInchesToTwip(0.05),
  right: docx.convertInchesToTwip(0.1),
  left: docx.convertInchesToTwip(0.1),
};

// `docx.percentage` and `docx.PERCENTAGE` are both undefined — the constant is
// `docx.WidthType.PERCENTAGE`. The original code used the first two, so every width in
// the generated form carried `type: undefined` and Word fell back to auto-sizing.
const PCT = docx.WidthType.PERCENTAGE;
const width = (size) => ({ size, type: PCT });

const PARAGRAPH_STYLES = [
  { name: 'Normal', run: { font: 'Arial' } },
  { name: 'docHeading', basedOn: 'Normal', run: { bold: true, size: 30 } },
  { name: 'teamHeading', basedOn: 'Normal', run: { bold: true, size: 24 } },
  { name: 'gender', basedOn: 'Normal', run: { bold: true } },
];

// The name the document is titled and filed under.
//
// Historically this was `teamNames[0]` with its last two characters chopped off, which
// works for "Hyde A" and produces "Alderley Park " (trailing space) for the league's one
// team not named "<club> <letter>". The club's own name is passed in where the caller
// has it — the team-admin page's Download link still resolves the old way, so that
// spelling is kept as the fallback rather than silently renaming seven committed files.
function docBaseName(teamNames, clubName) {
  if (clubName) return String(clubName);
  const first = String((teamNames && teamNames[0]) || '');
  return first.substring(0, Math.max(0, first.length - 2));
}

// Split a team's players into the four buckets the form lays out. rank 99 is a reserve;
// everything else is nominated, and the row order the query returned is the rank order.
function bucketsFor(rows, teamName) {
  const q = (predicate) => jp.query(rows, `$..[?(@.teamName=='${teamName}' && ${predicate})]`);
  return {
    nomMen: q("@.rank != 99 && @.gender == 'Male'"),
    nomLadies: q("@.rank != 99 && @.gender == 'Female'"),
    resMen: q("@.rank == 99 && @.gender == 'Male'"),
    resLadies: q("@.rank == 99 && @.gender == 'Female'"),
  };
}

// The structure the team-admin page renders, built from the same buckets as the document
// so the screen and the form a club receives cannot drift apart.
function teamBlocks(rows, teamNames, teamIds) {
  teamNames = teamNames || jp.query(rows, '$..teamName').filter((v, i, a) => a.indexOf(v) === i);
  teamIds = teamIds || jp.query(rows, '$..teamId').filter((v, i, a) => a.indexOf(v) === i);
  return {
    teams: teamNames.map((name, i) => {
      const b = bucketsFor(rows, name);
      return {
        name,
        id: teamIds[i],
        nominated: { men: b.nomMen, ladies: b.nomLadies },
        reserves: { men: b.resMen, ladies: b.resLadies },
      };
    }),
  };
}

function buildTable(rows, teamNames, title) {
  const table = new docx.Table({
    rows: [
      new docx.TableRow({
        children: [
          new docx.TableCell({
            children: [new docx.Paragraph({ text: title + ' Registrations', style: 'docHeading' })],
            columnSpan: 4,
          }),
        ],
      }),
    ],
    margins: CELL_MARGINS,
    width: width(100),
  });

  for (const teamName of teamNames) {
    table.addChildElement(new docx.TableRow({
      children: [
        new docx.TableCell({
          children: [new docx.Paragraph({ text: teamName, style: 'teamHeading' })],
          columnSpan: 4,
        }),
      ],
    }));
    table.addChildElement(new docx.TableRow({
      children: [
        new docx.TableCell({
          children: [new docx.Paragraph({ text: 'Men', style: 'gender' })], columnSpan: 2,
        }),
        new docx.TableCell({
          children: [new docx.Paragraph({ text: 'Ladies', style: 'gender' })], columnSpan: 2,
        }),
      ],
    }));

    const { nomMen, nomLadies, resMen, resLadies } = bucketsFor(rows, teamName);
    // The team's letter, taken off the end of its name — "Hyde B" gives "B". A reserve
    // gets "R" instead, which is the only place the .docx records reserve status.
    const letter = teamName.substring(teamName.length - 1);
    const longest = Math.max(nomMen.length + resMen.length, nomLadies.length + resLadies.length);

    for (let j = 1; j <= longest; j++) {
      const manName = j > (nomMen.length + resMen.length) ? ''
        : (j > nomMen.length ? resMen[j - nomMen.length - 1].name : nomMen[j - 1].name);
      const ladyName = j > (nomLadies.length + resLadies.length) ? ''
        : (j > nomLadies.length ? resLadies[j - nomLadies.length - 1].name : nomLadies[j - 1].name);
      const menLetter = j > nomMen.length ? 'R' : letter;
      const ladiesLetter = j > nomLadies.length ? 'R' : letter;

      table.addChildElement(new docx.TableRow({
        children: [
          new docx.TableCell({ children: [new docx.Paragraph(manName)], width: width(40) }),
          new docx.TableCell({ children: [new docx.Paragraph(menLetter)], width: width(10) }),
          new docx.TableCell({ children: [new docx.Paragraph(ladyName)], width: width(40) }),
          new docx.TableCell({ children: [new docx.Paragraph(ladiesLetter)], width: width(10) }),
        ],
      }));
    }
  }

  return table;
}

/**
 * Build the registration form for one club.
 *
 * @param {Array}  rows       getNamesClubsTeams output for that club — one row per player,
 *                            carrying teamName, teamId, name, gender and rank.
 * @param {string} [clubName] the club's own name, used for the title and file name.
 * @returns {Promise<{buffer: Buffer, baseName: string, teamNames: string[],
 *                    teamIds: any[], teamBlocks: object}>}
 */
exports.build = async function (rows, clubName) {
  const teamNames = jp.query(rows, '$..teamName').filter((v, i, a) => a.indexOf(v) === i);
  const teamIds = jp.query(rows, '$..teamId').filter((v, i, a) => a.indexOf(v) === i);
  if (!teamNames.length) throw new Error('registrationDocx: no teams in those rows');

  const baseName = docBaseName(teamNames, clubName);
  const doc = new docx.Document({
    title: baseName + ' Registrations',
    sections: [{ children: [buildTable(rows, teamNames, baseName)] }],
    styles: { paragraphStyles: PARAGRAPH_STYLES },
  });

  return {
    buffer: await docx.Packer.toBuffer(doc),
    baseName,
    teamNames,
    teamIds,
    teamBlocks: teamBlocks(rows, teamNames, teamIds),
  };
};

exports.docBaseName = docBaseName;
exports.teamBlocks = teamBlocks;

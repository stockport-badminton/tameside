// The pre-filled registration PDF with names its font cannot encode.
//
// The form's fields use a standard (WinAnsi) font, and pdf-lib throws at save() on any
// character outside it — "Ł", a CJK name, or the invisible bidi marks a value pasted from
// a phone carries. That throw is after every setField, so the whole form used to 500.
// Ported from Stockport (2355a03, their Sentry NODE-1A), plus a hand map for the letters
// that have no Unicode decomposition, which theirs drops ("Łukasz" -> "ukasz").

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');

const { app } = require('../helpers/app');
const Player = require('../../models/players');
const { _pdfSafeForTesting: pdfSafe } = require('../../controllers/documentsController');

afterEach(() => mock.restoreAll());

async function templateForm() {
  const bytes = fs.readFileSync(path.join(__dirname, '../../static/docs/Team Registration.pdf'));
  return (await PDFDocument.load(bytes)).getForm();
}

describe('pdfSafe', () => {
  it('keeps what WinAnsi has, folds what it lacks, drops the rest', async () => {
    const form = await templateForm();
    assert.strictEqual(pdfSafe(form, 'Zoë Brontë'), 'Zoë Brontë');
    assert.strictEqual(pdfSafe(form, 'Siân O’Neill'), 'Siân O’Neill');
    assert.strictEqual(pdfSafe(form, 'Łukasz Wałęsa'), 'Lukasz Walesa');
    assert.strictEqual(pdfSafe(form, 'Dvořák'), 'Dvorák'); // á is WinAnsi; ř is not
    assert.strictEqual(pdfSafe(form, '0161‭ 123‬'), '0161 123');
    assert.strictEqual(pdfSafe(form, '王小明'), '');
  });
});

describe('GET /forms/team-registration/:club/prefilled', () => {
  it('renders a roster whose names WinAnsi cannot encode', async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    process.env.DEV_MODE = 'true';
    process.env.DEV_ROLE = 'superadmin';
    mock.method(Player, 'getNamesClubsTeams', (terms, done) => done(null, [
      { name: 'Łukasz Nowak‭', gender: 'Male', teamName: 'Hyde A', rank: 1 },
      { name: '王小明', gender: 'Female', teamName: 'Hyde A', rank: 1 },
      { name: 'Ewa Wałęsa', gender: 'Female', teamName: 'Hyde A', rank: 99 },
    ]));
    try {
      const res = await request(app).get('/forms/team-registration/Hyde/prefilled')
        .buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      assert.strictEqual(res.status, 200);
      const form = (await PDFDocument.load(res.body)).getForm();
      assert.strictEqual(form.getTextField('MenOpenA').getText(), 'Lukasz Nowak');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

#!/usr/bin/env node
/**
 * Render every email to HTML you can open in a browser (or forward to yourself, which is
 * the only way to see what Outlook really does with it).
 *
 *   node tools/preview-emails.js [outDir]     # default: .preview-emails/
 *
 * Uses the same sample data as test/email-templates.test.js — test/fixtures/email-samples.js
 * — so a preview signed off by a human is the thing the tests assert on.
 */
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const CASES = require('../test/fixtures/email-samples');
const EMAIL_DIR = path.join(__dirname, '..', 'views', 'emails');
const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '.preview-emails'));

const render = (name, data) => new Promise((resolve, reject) =>
  ejs.renderFile(path.join(EMAIL_DIR, name + '.ejs'), data, (e, h) => e ? reject(e) : resolve(h)));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const index = [];
  for (const [name, data] of Object.entries(CASES)) {
    const html = await render(name, data);
    fs.writeFileSync(path.join(outDir, name + '.html'), html);
    const title = (html.match(/<title>([^<]*)<\/title>/) || [, name])[1];
    index.push({ name, title, bytes: html.length });
    console.log(`  ${name.padEnd(24)} ${String(html.length).padStart(6)} bytes  ${title}`);
  }
  fs.writeFileSync(path.join(outDir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>League emails</title>'
    + '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}'
    + 'li{margin:.4rem 0}code{color:#666;font-size:13px}</style>'
    + '<h1>League emails</h1><ul>'
    + index.map(e => `<li><a href="./${e.name}.html">${e.title}</a> <code>${e.name} · ${e.bytes} bytes</code></li>`).join('')
    + '</ul>');
  console.log(`\n  ${index.length} emails -> ${outDir}\n  open ${path.join(outDir, 'index.html')}`);
})().catch(err => { console.error(err.message); process.exit(1); });

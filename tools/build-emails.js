#!/usr/bin/env node
/**
 * Compile emails/*.mjml -> views/emails/*.ejs
 *
 *   node tools/build-emails.js          # compile all
 *   node tools/build-emails.js --check  # fail if the committed output is stale (CI/pre-push)
 *
 * WHY COMPILED OUTPUT IS COMMITTED
 *
 * The Dockerfile runs `npm ci --omit=dev`, so devDependencies never reach the image, and
 * mjml is a devDependency (it brings ~237 packages). Compiling here and committing the
 * result means production renders a plain EJS template with the ejs it already has —
 * the runtime path is exactly what it was before MJML existed. It also makes the diff
 * reviewable: you can see in git what the email will actually look like.
 *
 * The alternative — compiling in the image like `npm run build:css` does — would make
 * mjml a production dependency for the sake of a build step, which is the wrong trade
 * for a handful of templates that change a few times a year.
 *
 * EJS SURVIVES MJML. Verified against mjml 5.4: `<%= x %>`, `<% if (x) { %>` and
 * placeholders inside attributes (`href="<%= url %>"`) all pass through untouched and
 * unescaped, so the templates are written with EJS inline and compiled as normal MJML.
 *
 * Files starting with `_` are partials (theme/header/footer) and are not compiled on
 * their own — they are pulled in by `mj-include`.
 *
 * TWO MJML 5 GOTCHAS, both of which fail quietly:
 *   - the API is ASYNC. mjml2html() returns a Promise; treating it as synchronous gives
 *     you an object with no `html` and a template that is just the banner comment.
 *   - `mj-include` is DISABLED by default (`ignoreIncludes` defaults to true). Passing
 *     `filePath` alone is not enough — without `ignoreIncludes: false` the partials are
 *     silently dropped and you get a template with no header, footer or theme, and no
 *     error. The CLI equivalent is `--config.allowIncludes true`.
 */

const fs = require('fs');
const path = require('path');
const mjml2html = require('mjml');

const SRC_DIR = path.join(__dirname, '..', 'emails');
const OUT_DIR = path.join(__dirname, '..', 'views', 'emails');

const BANNER = (name) =>
  `<%# GENERATED FILE — do not edit.\n` +
  `    Source: emails/${name}.mjml   Rebuild: npm run build:email\n` +
  `    Editing this file directly will be overwritten by the next build. %>\n`;


// EJS tags in a template and everything it mj-includes, so the count can be compared with
// the compiled output. Recursive because partials include partials.
function countEjsTags(filePath, seen = new Set()) {
  const resolved = path.resolve(filePath);
  if (seen.has(resolved)) return 0;
  seen.add(resolved);
  const src = fs.readFileSync(resolved, 'utf8');
  let total = (src.match(/<%/g) || []).length;
  const dir = path.dirname(resolved);
  for (const m of src.matchAll(/<mj-include\s+path=["']([^"']+)["']/g)) {
    const inc = path.resolve(dir, m[1]);
    if (fs.existsSync(inc)) total += countEjsTags(inc, seen);
  }
  return total;
}

async function compile(name) {
  const srcPath = path.join(SRC_DIR, name + '.mjml');
  const src = fs.readFileSync(srcPath, 'utf8');
  const { html, errors } = await mjml2html(src, {
    filePath: srcPath,        // so mj-include resolves paths relative to the template
    ignoreIncludes: false,    // REQUIRED, see the note above — silently drops partials otherwise
    validationLevel: 'strict',
    minify: false,            // keep it readable in git; 25KB is nowhere near Gmail's 102KB clip
  });
  if (errors && errors.length) {
    for (const e of errors) console.error(`  ${name}: ${e.formattedMessage || e.message}`);
    throw new Error(`${name}.mjml failed to compile`);
  }
  if (!html || !html.includes('</html>')) {
    throw new Error(`${name}.mjml produced no html — check the mjml options`);
  }

  // Guard against MJML silently eating an EJS tag.
  //
  // An EJS tag inside a text node survives compilation. One sitting directly BETWEEN two
  // MJML components is discarded — and the content it was guarding then renders
  // unconditionally, with no error. That is how `<% if (photoUrl) { %>` around an
  // <mj-text> turns into a photo link that always shows. The fix is to wrap such a
  // conditional in <mj-raw>; this check is what stops the mistake shipping.
  const sourceTags = countEjsTags(srcPath);
  const outputTags = (html.match(/<%/g) || []).length;
  if (outputTags < sourceTags) {
    throw new Error(
      `${name}.mjml: ${sourceTags - outputTags} EJS tag(s) were dropped by the compiler ` +
      `(source ${sourceTags}, output ${outputTags}).\n` +
      `    An EJS tag between two MJML components is discarded and whatever it guarded ` +
      `renders unconditionally.\n` +
      `    Wrap it in <mj-raw>: <mj-raw><% if (x) { %></mj-raw> ... <mj-raw><% } %></mj-raw>`);
  }

  return BANNER(name) + html;
}

async function main() {
  const check = process.argv.includes('--check');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const names = fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.mjml') && !path.basename(f).startsWith('_'))
    .map(f => f.replace(/\.mjml$/, ''))
    .sort();

  if (!names.length) {
    console.error('No .mjml templates found in emails/');
    process.exit(1);
  }

  let stale = 0;
  for (const name of names) {
    const out = await compile(name);
    const outPath = path.join(OUT_DIR, name + '.ejs');
    const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;

    if (check) {
      if (existing !== out) { console.error(`  STALE: views/emails/${name}.ejs`); stale++; }
      else console.log(`  ok:    views/emails/${name}.ejs`);
      continue;
    }
    if (existing === out) {
      console.log(`  unchanged: views/emails/${name}.ejs`);
    } else {
      fs.writeFileSync(outPath, out);
      console.log(`  wrote:     views/emails/${name}.ejs  (${out.length} bytes)`);
    }
  }

  if (check && stale) {
    console.error(`\n${stale} template(s) are out of date. Run: npm run build:email`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });

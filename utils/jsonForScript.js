// Embedding a JSON value inside an inline <script> block.
//
// `JSON.stringify` alone is NOT safe there, and the reason is that the browser finds the
// end of a `<script>` element before any JavaScript is parsed. A string containing
// `</script>` closes the block early — everything after it becomes page content, the
// remaining JS runs as markup, and anything an author put after that runs as script. The
// same is true of `<!--`, which starts an HTML comment inside a script block.
//
// So the four characters below are escaped as `\uXXXX`. That is a no-op as far as
// JavaScript is concerned — `"<"` and `"<"` are the same string — but there is no
// longer a literal `<` for the HTML parser to find.
//
// U+2028 and U+2029 are here for a different reason: they are valid inside a JSON string
// but were line terminators in JavaScript before ES2019, so an older engine sees an
// unterminated string literal and a syntax error. Cheap to keep correct.
//
// **This matters here because the values are free text a club admin types.** A venue
// address in this database already carries an apostrophe ("NOT Mulberry's"); nothing stops
// one carrying angle brackets.
//
// Used by `views/club.ejs` for the venue map. **`views/fixtures-gen.ejs` (twice) and
// `views/lewis-shield.ejs` do the same `<%- JSON.stringify(...) %>` and have not been
// converted** — they are admin-only pages and were out of scope for the change that added
// this. They should use this too.

const ESCAPES = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * JSON, safe to drop straight into a `<script>` block with `<%- %>`.
 *
 * Returns the string `null` for an undefined value rather than the empty string, because
 * `var x = ;` is a syntax error that takes the whole page's script with it.
 */
function jsonForScript(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json.replace(/[<>&\u2028\u2029]/g, c => ESCAPES[c]);
}

module.exports = jsonForScript;
module.exports.jsonForScript = jsonForScript;

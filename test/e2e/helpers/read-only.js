// Network guard: makes "this test doesn't write" an enforced property.
//
// The Playwright server here runs against the PRODUCTION database (there is no local one),
// so any mutating request the browser makes is aborted, recorded, and fails the test via
// assertNoWrites(). A test that needs to exercise a write answers it itself with
// page.route() registered AFTER this guard — Playwright runs the most recently added
// matching route first, so the test's handler wins and nothing reaches the server.
//
// What this cannot see is a write the server makes on its own; the roster pages make none
// on a GET. Ported from Stockport's e2e/helpers/read-only.js.
const { expect } = require('@playwright/test');

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
// Same-origin endpoints with a mutating verb that only read.
const READ_ONLY_POSTS = [/^\/teams$/];

async function readOnly(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const attempted = [];
  await page.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin || READ_METHODS.includes(req.method())
        || READ_ONLY_POSTS.some((re) => re.test(url.pathname))) {
      return route.continue();
    }
    attempted.push(req.method() + ' ' + url.pathname);
    return route.abort();
  });
  return {
    assertNoWrites() {
      expect(attempted, 'the page attempted a write: ' + attempted.join(', ')).toEqual([]);
    },
  };
}

module.exports = { readOnly };

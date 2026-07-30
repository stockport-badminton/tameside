// Viewport regression guard for views/nav.ejs.
//
// The nav is position:sticky (modern-styles.css), so it sits in document flow —
// an expanded menu wider than the viewport widens the whole page and pushes the
// right-most item off-screen. That item is the Admin / Log in menu, so the failure
// silently costs logged-in users their only route to the admin pages.
//
// This happened twice: expand-lg overflowed, was moved to expand-xl (commit
// c08217ff), and expand-xl still left a dead zone at 1200-1399px because the
// expanded logged-in nav needs ~1392px. 1366x768 laptops sat squarely in it.
//
// These tests are deliberately about *layout*, not the wizard the rest of
// test/e2e covers. They run under DEV_MODE=true (see playwright.config.js), which
// injects a mock superadmin — the widest possible nav, with every admin item
// present. That's the case worth guarding.
const { test, expect } = require('@playwright/test');

// Common real-world widths. The 1200-1399 entries are the ones that regressed
// before; 1366 and 1280 are among the most common laptop resolutions. 1600/1750
// are the boundaries of the width trim in modern-styles.css, where the full-size
// brand and link padding resume — historically the tightest expanded widths.
const WIDTHS = [1920, 1800, 1750, 1700, 1680, 1600, 1536, 1440, 1400, 1366, 1280, 1200, 1199, 1024, 768, 390];

// Minimum free space (px) that `ms-auto` must leave between the brand and the
// nav items, at any width where the nav is expanded. This is the slack that
// absorbs a newly added top-level item — the narrowest current item is ~99px, so
// 110px means one more item can be added without a user ever seeing overflow.
// Nothing about the layout enforces this; it exists so growth fails loudly here.
const MIN_FREE_SPACE = 110;

// Any page that includes nav.ejs will do; /rules is static and cheap (no DB work).
const PAGE = '/rules';

for (const width of WIDTHS) {
  test(`nav fits and stays reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

    // The brand is Poppins and the links Inter, both pulled in by a <link> in
    // header.ejs. Measuring before they land gives fallback-font widths — which
    // are narrower, so an overflowing nav can measure as fitting. This wait is
    // what makes the assertions below deterministic; without it the 1366px case
    // flakes to a pass.
    await page.evaluate(() => document.fonts.ready);

    const metrics = await page.evaluate(() => {
      const toggler = document.querySelector('.navbar-toggler');
      const items = [...document.querySelectorAll('.navbar-nav > .nav-item')];
      const last = items[items.length - 1];
      const brand = document.querySelector('.navbar-brand');
      const ul = document.querySelector('.navbar-nav');

      return {
        // The hamburger being displayed is what "collapsed" actually means —
        // more reliable than re-deriving the Bootstrap breakpoint here.
        collapsed: !!toggler && getComputedStyle(toggler).display !== 'none',
        itemCount: items.length,
        lastLabel: last ? last.innerText.trim().split('\n')[0] : null,
        lastRight: last ? last.getBoundingClientRect().right : null,
        // The nav-nav is ms-auto, so it's flush right and this gap is all the
        // unused width in the navbar — i.e. the room a new item has to grow into.
        freeSpace: Math.round(
          ul.getBoundingClientRect().left - brand.getBoundingClientRect().right
        ),
        docScrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });

    // Sanity: DEV_MODE should have logged us in, so the last item is the Admin
    // menu. If this fails the rest of the test is measuring the wrong thing.
    expect(metrics.itemCount).toBeGreaterThan(0);
    expect(metrics.lastLabel).toBe('Admin');

    // The real assertion: the page must never scroll horizontally. This is what
    // "nav cut off on the right" looks like in measurements.
    expect(
      metrics.docScrollWidth,
      `page scrolls horizontally at ${width}px (nav overflow)`
    ).toBeLessThanOrEqual(metrics.clientWidth);

    // When expanded, the right-most menu must be fully inside the viewport.
    // When collapsed it's inside the hidden .navbar-collapse, so it has no
    // meaningful box and there's nothing to check.
    if (!metrics.collapsed) {
      expect(
        metrics.lastRight,
        `Admin menu extends past the viewport edge at ${width}px`
      ).toBeLessThanOrEqual(metrics.clientWidth);

      // Headroom, not correctness: the nav fits today, but with too little slack
      // the next top-level item pushes the Admin menu off-screen again. Failing
      // here is the signal to widen the trim band in modern-styles.css.
      expect(
        metrics.freeSpace,
        `only ${metrics.freeSpace}px of slack at ${width}px — one more nav item would overflow`
      ).toBeGreaterThanOrEqual(MIN_FREE_SPACE);
    }
  });
}

test('the collapsed nav still exposes the Admin menu via the toggler', async ({ page }) => {
  // Below 1400px the nav collapses, so the Admin menu is only reachable through
  // the hamburger. Guard that path too — a nav that fits but can't be opened is
  // the same outcome for the user.
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);

  const toggler = page.locator('.navbar-toggler');
  await expect(toggler).toBeVisible();

  await toggler.click();

  const admin = page.locator('.navbar-nav > .nav-item').last();
  await expect(admin).toBeVisible();
  await expect(admin).toContainText('Admin');
});

// --- Tall-menu reachability -------------------------------------------------
//
// The width tests above only prove the nav fits horizontally. The other way to
// lose a menu item is vertically: the navbar is position:sticky, so anything
// inside it below the fold is unreachable — page scrolling moves the content
// behind the nav, not the nav itself. With the hamburger and the 16-item
// superadmin Admin menu both open the nav was ~1040px tall on a 1366x768 laptop,
// and scrolling to the end of the page still left the last items ~254px down.
//
// These pairs deliberately vary HEIGHT, not just width: short windows (600-700px)
// are where the expanded dropdown overflows, and phone sizes are where the
// collapsed panel does. 320x568 is the narrowest case, where the brand still
// wraps the navbar header onto two rows.
const TALL_MENU_VIEWPORTS = [
  { width: 320, height: 568 },   // narrowest — navbar header wraps to 2 rows
  { width: 390, height: 844 },   // modern phone
  { width: 390, height: 667 },   // older/shorter phone
  { width: 768, height: 600 },   // tablet, short
  { width: 1200, height: 640 },  // collapsed, short
  { width: 1366, height: 768 },  // the laptop that started all this
  { width: 1399, height: 700 },  // last collapsed width
  { width: 1440, height: 600 },  // expanded but short — absolute dropdown overflows
  { width: 1920, height: 600 },  // expanded, wide, short
  { width: 1920, height: 1080 }, // no scrolling needed at all
];

for (const { width, height } of TALL_MENU_VIEWPORTS) {
  test(`every Admin item is reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);

    const collapsed = await page.evaluate(
      () => getComputedStyle(document.querySelector('.navbar-toggler')).display !== 'none'
    );
    if (collapsed) {
      await page.click('.navbar-toggler');
      // Wait out Bootstrap's collapse transition; measuring mid-animation gives
      // a height that is neither the closed nor the open one.
      await page.waitForTimeout(450);
    }

    // Open the Admin dropdown — the tallest menu on the site.
    await page.click('.navbar-nav > .nav-item:last-child > .nav-link');
    await page.waitForTimeout(400);

    const result = await page.evaluate(async () => {
      const dd = document.querySelector('.navbar-nav > .nav-item:last-child .dropdown-menu');
      const items = dd.querySelectorAll('.dropdown-item');
      const last = items[items.length - 1];
      const collapse = document.querySelector('.navbar-collapse');

      // Which element actually scrolls depends on the breakpoint: collapsed, the
      // dropdown is position:static inside the collapse panel, so the panel is the
      // scroller; expanded, the dropdown is position:absolute and scrolls itself.
      const scroller =
        getComputedStyle(collapse).overflowY === 'auto' ? collapse : dd;
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => setTimeout(r, 150));

      const rect = last.getBoundingClientRect();
      return {
        itemCount: items.length,
        label: last.textContent.trim(),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        viewportHeight: window.innerHeight,
      };
    });

    // Sanity: this must be the full superadmin menu, or we're not testing the
    // tall case at all.
    expect(result.itemCount).toBeGreaterThanOrEqual(15);
    expect(result.label).toBe('Logout');

    // Scrolled to the end of whichever container scrolls, the final item must be
    // fully on screen. Both bounds matter: too-small a max-height would push it
    // below the fold, too-large a one would put it above the top.
    expect(
      result.bottom,
      `last Admin item ends ${result.bottom - result.viewportHeight}px below the fold at ${width}x${height}`
    ).toBeLessThanOrEqual(result.viewportHeight);
    expect(
      result.top,
      `last Admin item sits above the viewport top at ${width}x${height}`
    ).toBeGreaterThanOrEqual(0);
  });
}

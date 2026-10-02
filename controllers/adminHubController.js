// GET /admin — every superadmin tool on one page, grouped (utils/adminTools.js). Ported from
// Stockport (league-site 566234b).
//
// The counts are the reason to open this rather than just a longer menu, and each is
// independent: a count that fails to load shows as nothing, never as a broken page, because
// the page's first job is to be a list of links.
const Sentry = require('@sentry/node');
const { GROUPS } = require('../utils/adminTools');
const ClubRegistration = require('../models/clubRegistration');
const MissedThree = require('../models/missedThree');
const seasonModel = require('../models/season');

async function safely(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.log(`[admin hub] count ${label} failed: ${err.message}`);
    Sentry.captureException(err, { tags: { step: 'admin hub count: ' + label } });
    return null;
  }
}

exports.hub = async function (req, res, next) {
  try {
    const [formsOutstanding, missedThree] = await Promise.all([
      safely('formsOutstanding', async () =>
        (await ClubRegistration.getStatus(seasonModel.current())).filter(c => !c.received).length),
      safely('missedThree', async () => (await MissedThree.getPlayers()).length),
    ]);
    res.render('admin/hub', {
      static_path: '/static',
      title: 'Admin',
      pageDescription: 'Every league admin tool',
      groups: GROUPS,
      counts: { formsOutstanding, missedThree },
    });
  } catch (err) {
    next(err);
  }
};

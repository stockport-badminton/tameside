var SiteSettings = require('../models/siteSettings');
var LewisHandicap = require('../models/lewisHandicap');

const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

// Shared with every other admin-gated controller — utils/authz.js owns the claim key.
const { isSuperAdmin } = require('../utils/authz');

exports.form = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const [settings, lewisSecretary, candidates] = await Promise.all([
      promisify(SiteSettings.getAll)(), LewisHandicap.secretaryId(), LewisHandicap.candidates(),
    ]);
    res.render('admin/site-settings-form', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Site Settings',
      pageDescription: 'Manage site settings',
      settings,
      lewisSecretary,
      candidates
    });
  } catch (err) {
    next(err);
  }
};

exports.update = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    await promisify(SiteSettings.set)('homepage_gallery_tag', req.body.homepage_gallery_tag || '');
    // Teams up and down between divisions (League.movingPlaces): a whole number 0-4, or
    // left as it was. It varies by season, so it is a setting rather than a constant.
    const places = String(req.body.promotion_places ?? '').trim();
    if (/^[0-4]$/.test(places)) await promisify(SiteSettings.set)('promotion_places', places);
    // The Lewis secretary (controllers/lewisHandicapController.js): a player id, '' for
    // none, or absent to leave it. Only someone on a team can be picked.
    if (req.body.lewis_secretary !== undefined) {
      const id = String(req.body.lewis_secretary).trim();
      if (id === '') await LewisHandicap.setSecretary(null);
      else if (/^\d+$/.test(id) && (await LewisHandicap.candidates()).some(p => p.id === Number(id))) {
        await LewisHandicap.setSecretary(Number(id));
      }
    }
    res.redirect('/admin/site-settings');
  } catch (err) {
    next(err);
  }
};

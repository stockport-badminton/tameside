var SiteSettings = require('../models/siteSettings');

const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

// Shared with every other admin-gated controller — utils/authz.js owns the claim key.
const { isSuperAdmin } = require('../utils/authz');

exports.form = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const settings = await promisify(SiteSettings.getAll)();
    res.render('admin/site-settings-form', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Site Settings',
      pageDescription: 'Manage site settings',
      settings
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
    res.redirect('/admin/site-settings');
  } catch (err) {
    next(err);
  }
};

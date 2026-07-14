var SiteSettings = require('../models/siteSettings');

const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

function isSuperAdmin(req) {
  return !!(req.user && req.user._json && req.user._json['https://my-app.example.com/role'] === 'superadmin');
}

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
    res.redirect('/admin/site-settings');
  } catch (err) {
    next(err);
  }
};

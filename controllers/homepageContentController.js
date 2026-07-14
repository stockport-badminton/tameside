var HomepageContent = require('../models/homepageContent');
const sanitizeHtml = require('sanitize-html');

const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

// data-bs-toggle / data-bs-target are allowed on links so announcements can
// open on-page Bootstrap modals (the seeded "quick guide to results entry"
// card relies on this surviving an edit).
const SANITIZE_OPTS = {
  allowedTags: ['p', 'br', 'strong', 'em', 'a', 'img', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4'],
  allowedAttributes: {
    a: ['href', 'target', 'data-bs-toggle', 'data-bs-target'],
    img: ['src', 'alt']
  }
};

function isSuperAdmin(req) {
  return !!(req.user && req.user._json && req.user._json['https://my-app.example.com/role'] === 'superadmin');
}

// NB: page titles must not contain "Homepage" or "Event" — header.ejs branches
// on those substrings and dereferences homepage-only locals.
function renderOpts(title, pageDescription, extra) {
  return Object.assign({
    static_path: '/static',
    theme: process.env.THEME || 'flatly',
    title,
    pageDescription
  }, extra);
}

function announcementFromBody(body) {
  return {
    title: body.title,
    teaser_html: sanitizeHtml(body.teaser_html || '', SANITIZE_OPTS),
    modal_body_html: body.modal_body_html ? sanitizeHtml(body.modal_body_html, SANITIZE_OPTS) : null,
    image_url: body.image_url || null,
    show_gallery_link: body.show_gallery_link === 'on',
    sort_order: parseInt(body.sort_order, 10) || 0,
    active: body.active === 'on'
  };
}

exports.list = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const announcements = await promisify(HomepageContent.getAll)();
    res.render('admin/homepage-content-list', renderOpts('Content Admin', 'Manage announcements', { announcements }));
  } catch (err) {
    next(err);
  }
};

exports.createForm = function(req, res) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  res.render('admin/homepage-content-form', renderOpts('New Announcement', 'Create an announcement', { announcement: null }));
};

exports.create = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  if (!req.body.title || !req.body.title.trim()) return res.status(400).send('Title required');
  try {
    await promisify(HomepageContent.create)(announcementFromBody(req.body));
    res.redirect('/admin/homepage-content');
  } catch (err) {
    next(err);
  }
};

exports.editForm = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const announcement = await promisify(HomepageContent.getById)(req.params.id);
    if (!announcement) return res.status(404).send('Not found');
    res.render('admin/homepage-content-form', renderOpts('Edit Announcement', 'Edit an announcement', { announcement }));
  } catch (err) {
    next(err);
  }
};

exports.update = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  if (!req.body.title || !req.body.title.trim()) return res.status(400).send('Title required');
  try {
    await promisify(HomepageContent.updateById)(req.params.id, announcementFromBody(req.body));
    res.redirect('/admin/homepage-content');
  } catch (err) {
    next(err);
  }
};

exports.remove = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    await promisify(HomepageContent.deleteById)(req.params.id);
    res.redirect('/admin/homepage-content');
  } catch (err) {
    next(err);
  }
};

// Shared "not found" renderer.
//
// Extracted from fixtureController so every route that has to reject an
// unrecognised URL segment answers the same way. The no-store header is the part
// worth not losing: the domain fronts Cloud Run through Firebase Hosting, whose
// edge applies a default 10-minute cache to any cookie-less response that carries
// no Cache-Control. Without it a 404 sticks to a URL that has since become valid
// — e.g. a season archive that gets created later in the day.
//
// Mirrors the catch-all in app.js.
module.exports = function render404(req, res) {
  res.set('Cache-Control', 'private, no-store');
  return res.status(404).render('404-error', {
    static_path: "/static",
    title: "Can't find the page your looking for",
    pageDescription: "Can't find the page your looking for",
    entry: "<p>Sorry can't find that page</p>"
  });
};

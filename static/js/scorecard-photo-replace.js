// Superadmin: attach or replace the photo on a filed scorecard, from the confirmation page.
//
// This used to be done by blanking `scoresheet-url` in the database and re-uploading
// through /email-scorecard's "Add scorecard photos" list. Choosing a file uploads and
// previews it; nothing changes on the scorecard until "Use this file" is pressed.
//
// The new file gets its own key (row id + timestamp), so the original object is never
// overwritten: if the replacement turns out to be the wrong one, the old file is still in
// the bucket.
(function () {
  'use strict';
  var panel = document.getElementById('scorecard-photo-panel');
  if (!panel) return;
  var id = panel.getAttribute('data-scorecard-id');
  var input = document.getElementById('replace-photo-file');
  var preview = document.getElementById('replace-photo-preview');
  var img = document.getElementById('replace-photo-img');
  var pdf = document.getElementById('replace-photo-pdf');
  var name = document.getElementById('replace-photo-name');
  var save = document.getElementById('replace-photo-save');
  var status = document.getElementById('replace-photo-status');
  var pendingUrl = null;

  function say(text) { status.textContent = text; }

  input.addEventListener('change', async function () {
    var file = input.files[0];
    pendingUrl = null;
    save.disabled = true;
    preview.hidden = true;
    if (!file) return;
    var ext = (file.name.indexOf('.') >= 0 ? file.name.split('.').pop() : 'jpg').toLowerCase();
    var key = 'tameside-scorecard-' + id + '-' + Date.now() + '.' + ext;
    try {
      say('Uploading…');
      var url = await window.scorecardUpload.signAndPut(file, key);
      var isDoc = window.scorecardUpload.CONVERTIBLE.test(file.name);
      if (isDoc) say('Pulling the photo out of the file…');
      var conv = await window.scorecardUpload.convertIfDocument(key, url);

      // The same order as the wizard: the extracted photo, else the local image, else
      // the browser's own pdf viewer, else just the name.
      var src = conv.preview || (isDoc ? null : URL.createObjectURL(file));
      var inViewer = !src && /\.pdf$/i.test(file.name) && navigator.pdfViewerEnabled === true;
      if (src) { img.src = src; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
      if (inViewer) { pdf.src = URL.createObjectURL(file) + '#toolbar=0&navpanes=0&view=FitH'; pdf.hidden = false; }
      else { pdf.removeAttribute('src'); pdf.hidden = true; }
      name.textContent = file.name;
      preview.hidden = false;

      pendingUrl = conv.url;
      save.disabled = false;
      say(isDoc && !conv.converted
        ? 'Uploaded. The photo could not be pulled out of this file, so the file itself will be attached.'
        : 'Uploaded. Check it is the right card, then press "Use this file".');
    } catch (e) {
      say('⚠ ' + e.message);
    }
  });

  save.addEventListener('click', async function () {
    if (!pendingUrl) return;
    save.disabled = true;
    say('Saving…');
    try {
      var resp = await fetch('/add-scorecard-photo/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imgURL: pendingUrl }),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) throw new Error(data.error || 'The scorecard could not be updated.');
      say('✓ Saved.');
      window.location.reload();
    } catch (e) {
      say('⚠ ' + e.message);
      save.disabled = false;
    }
  });
})();

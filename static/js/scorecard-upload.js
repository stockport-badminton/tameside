// Putting a scorecard file into the bucket, and turning a document into a photo.
//
// Shared by the entry wizard (views/email-scorecard.ejs) and the superadmin "Replace photo"
// panel on the confirmation page (views/populated-scorecard.ejs), so that a pdf, docx or
// HEIC goes through the same conversion whichever page it was attached on.
(function () {
  'use strict';

  var CONVERTIBLE = /\.(pdf|docx|doc|heic|heif)$/i;

  // Presign, PUT, and return the object's url (the presigned one minus its query).
  //
  // No `.replaceAll('%20','+')`: that rewrite names a key GetObject cannot find, and is
  // why utils/scorecardPhoto.js has to undo it for 314 existing rows.
  async function signAndPut(file, key) {
    var sign = await fetch('/sign-s3?file-name=' + encodeURIComponent(key) + '&file-type=' + encodeURIComponent(file.type));
    if (!sign.ok) throw new Error('Could not start the upload.');
    var signedUrl = (await sign.json()).signedUrl;
    var put = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
    if (!put.ok) throw new Error('The file could not be uploaded to storage.');
    return signedUrl.substr(0, signedUrl.indexOf('?X-Amz'));
  }

  // A pdf or docx is a photo with a wrapper round it, and the server can pull the photo
  // out — see utils/documentImage.js. The file has already been PUT to the bucket by the
  // time this runs, so the server is handed the KEY and reads it back.
  //
  // Returns { url, key, preview, converted, reason }: `url` is what to record. A document
  // that cannot be read keeps its own url and key: the file is still uploaded and still
  // attached, so this is never a failure. `preview` is a data url of the extracted photo,
  // or null.
  async function convertIfDocument(key, uploadedUrl) {
    var unchanged = { url: uploadedUrl, key: key, preview: null, converted: false };
    if (!CONVERTIBLE.test(key)) return unchanged;
    var resp = await fetch('/scorecard-document/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key }),
    });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(data.error || 'Could not read that file.');
    if (!data.converted) return Object.assign(unchanged, { reason: data.reason });
    return { url: data.url, key: data.key, preview: data.preview || null, converted: true };
  }

  // ── Uploads still in flight ──────────────────────────────────────────────────────
  //
  // Submitting the form navigates, and navigating kills any fetch still running. The
  // photo's url only reaches `scoresheet-url` once its upload FINISHES, so a captain who
  // picks a photo and presses Submit before then files the scorecard with no photo, and
  // nothing on the form knew an upload was running. Stockport traced one such draft to
  // the second (their 7ce8017): a 3.6MB iPhone photo sixteen seconds into its PUT, which
  // failed 28ms after the click.
  //
  // begin() marks the start of storing a photo and returns `settle(ok)`, to be called
  // once `scoresheet-url` holds its final value (ok) or the store has failed (not ok).
  // Settling twice is harmless, so a catch can always settle(false).
  var pending = [];

  function begin() {
    var settle;
    var p = new Promise(function (resolve) { settle = resolve; });
    pending.push(p);
    p.then(function () { pending = pending.filter(function (q) { return q !== p; }); });
    return function (ok) { settle(ok !== false); };
  }

  // Resolves once nothing is in flight, to whether everything that was succeeded.
  function whenIdle() {
    if (!pending.length) return Promise.resolve(true);
    return Promise.all(pending).then(function (results) {
      // Let the settled promises' own clean-up run, then check nothing new started.
      return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
        return whenIdle().then(function (later) { return later && results.every(Boolean); });
      });
    });
  }

  // Hold a form's submission until its uploads have finished.
  //
  // Submits by itself once they succeed: the captain already pressed Submit, and asking
  // twice would read as the first press having failed. If one failed, the upload box has
  // already said so, so this stops and says what to do next: a second press, with nothing
  // in flight, files without the photo — a choice the captain makes knowing.
  function guardSubmit(form) {
    if (!form || form.__uploadGuard) return;
    form.__uploadGuard = true;
    var note = document.createElement('small');
    note.className = 'upload-wait-note d-block mt-2';
    note.hidden = true;
    var waiting = false;

    form.addEventListener('submit', function (e) {
      if (waiting) { e.preventDefault(); return; }
      if (!pending.length) return;
      e.preventDefault();
      waiting = true;

      var buttons = Array.prototype.slice.call(form.querySelectorAll('button[type="submit"], input[type="submit"]'));
      var labels = buttons.map(function (b) { return b.innerHTML; });
      buttons.forEach(function (b) { b.disabled = true; b.textContent = 'Uploading photo…'; });
      var anchor = buttons[buttons.length - 1];
      if (anchor && !note.parentNode) anchor.insertAdjacentElement('afterend', note);
      note.className = 'upload-wait-note d-block mt-2 text-muted';
      note.textContent = 'Waiting for the photo to finish uploading before sending the scorecard.';
      note.hidden = false;

      whenIdle().then(function (ok) {
        waiting = false;
        buttons.forEach(function (b, i) { b.disabled = false; b.innerHTML = labels[i]; });
        if (ok) {
          note.hidden = true;
          // The prototype's submit, not form.submit: a control named "submit" would
          // shadow the method. It fires no submit event, so this handler cannot rerun.
          HTMLFormElement.prototype.submit.call(form);
          return;
        }
        note.className = 'upload-wait-note d-block mt-2 text-danger';
        note.textContent = 'The photo did not upload, so nothing has been sent yet. Choose '
          + 'the photo again, or press Submit to send the scorecard without it.';
      });
    });
  }

  window.scorecardUpload = {
    signAndPut: signAndPut, convertIfDocument: convertIfDocument, CONVERTIBLE: CONVERTIBLE,
    begin: begin, whenIdle: whenIdle, guardSubmit: guardSubmit,
  };
  // The wizard's inline scripts call it by its bare name.
  window.convertIfDocument = convertIfDocument;
})();

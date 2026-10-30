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

  window.scorecardUpload = { signAndPut: signAndPut, convertIfDocument: convertIfDocument, CONVERTIBLE: CONVERTIBLE };
  // The wizard's inline scripts call it by its bare name.
  window.convertIfDocument = convertIfDocument;
})();

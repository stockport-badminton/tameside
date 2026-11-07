// Reading a received email back from Resend. Receiving only: Mailjet still sends everything.
//
// The webhook carries only metadata, so the body, headers and authentication results come
// from `GET /emails/receiving/{id}`, and attachments from its `/attachments` list, whose
// entries carry a short-lived `download_url`.
//
// `fetch`, not the `resend` SDK, like utils/metaPublisher.js. And `fetch` does not throw on
// a 4xx, so every call checks the status itself.
//
// Required as a MODULE by the controller and called through, so a test can stub it.

const API = 'https://api.resend.com';

// Inside the 60s request ceiling with room for the Mailjet send after it.
const TIMEOUT_MS = 15000;

async function api(path) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend GET ${path} answered ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function getEmail(emailId) {
  return api(`/emails/receiving/${encodeURIComponent(emailId)}`);
}

// Metadata only; the bytes are fetched by downloadAttachments, which knows the size cap.
async function listAttachments(emailId) {
  const body = await api(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
  return Array.isArray(body && body.data) ? body.data : [];
}

/**
 * Download attachments up to `maxBytes` in total. Anything that would take the total past
 * it is left out and named in `skipped`, so the forward can say so rather than fail: Mailjet
 * inlines attachments and refuses a request over 15MB.
 *
 * @returns {{ files: {filename, contentType, content: Buffer, contentId?}[], skipped: string[] }}
 */
async function downloadAttachments(list, maxBytes) {
  const files = [];
  const skipped = [];
  let total = 0;
  for (const a of list) {
    const name = a.filename || 'attachment';
    // base64 grows the bytes by a third, and that is what Mailjet's limit counts.
    const cost = Math.ceil((Number(a.size) || 0) * 4 / 3);
    if (!a.download_url || total + cost > maxBytes) { skipped.push(name); continue; }
    const res = await fetch(a.download_url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) { skipped.push(name); continue; }
    const content = Buffer.from(await res.arrayBuffer());
    const actual = Math.ceil(content.length * 4 / 3);
    if (!content.length || total + actual > maxBytes) { skipped.push(name); continue; }
    total += actual;
    files.push({
      filename: name,
      contentType: a.content_type || 'application/octet-stream',
      content,
      // Inline images are referenced from the html as cid:…, so they have to go back out
      // as inline parts with the same id, or the html shows broken images.
      contentId: (a.content_disposition === 'inline' && a.content_id) ? String(a.content_id).replace(/^<|>$/g, '') : undefined,
    });
  }
  return { files, skipped };
}

module.exports = { getEmail, listAttachments, downloadAttachments };

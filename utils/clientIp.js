// The visitor's IP address, resolved once so every consumer agrees.
//
// Behind Firebase Hosting → Cloud Run there are two proxies in front of this app, so
// `req.socket.remoteAddress` is a Google frontend and useless for identifying a visitor.
// Cloud Run documents X-Forwarded-For as `client, proxy...`, so the leftmost entry is the
// visitor. `req.ip` with `trust proxy` enabled (app.js sets it in production) gives the
// same answer and is preferred, so anything else reading req.ip cannot disagree with this.
//
// The trade-off worth being explicit about: the leftmost XFF entry is ultimately
// client-settable, because a caller can send their own X-Forwarded-For and Google appends
// to it. So this is good enough to block casual abuse and not good enough to be the only
// defence — which is why the captcha, honeypot and timing checks exist alongside it. It
// also means a determined caller can make the submission log show an address that isn't
// theirs, so check the log's user agent and pattern before blocking an address by hand.
function clientIp(req) {
  if (!req) return '';
  let ip = req.ip;

  if (!ip) {
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (xff) ip = String(xff).split(',')[0].trim();
  }
  if (!ip) ip = (req.socket && req.socket.remoteAddress) || '';

  ip = String(ip).trim();
  // Express reports IPv4-over-IPv6 as ::ffff:1.2.3.4; store the readable form so a
  // blocklist entry typed as a plain IPv4 address matches.
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// The raw header, kept alongside the resolved address in the submission log so a
// suspicious entry can be examined rather than guessed at.
function forwardedChain(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  return xff ? String(xff) : '';
}

module.exports = { clientIp, forwardedChain };

// Injected into every page of the recording: captions, a pointer, a spotlight and full-screen
// title cards. All in-page, so they are in the video at full resolution.
//
// Ported from Stockport (league-site tools/demo-video/overlay.js, 4d6cf0d). Two changes: the
// title cards' background is window.__dmCardBg (ours is the results-header navy, theirs purple), and
// the app name on a drawn notification is window.__dmApp rather than their league's name.
window.__demo = (() => {
  const css = `
  #dm-cap{position:fixed;left:0;right:0;margin:0 auto;width:fit-content;bottom:var(--cap-bottom,7%);transform:translateY(20px);opacity:0;z-index:100000;
    max-width:min(88vw,900px);box-sizing:border-box;padding:.55em 1.1em;border-radius:14px;background:rgba(17,24,39,.9);color:#fff;
    font:600 var(--cap-size,26px)/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;
    box-shadow:0 10px 30px rgba(0,0,0,.35);transition:opacity .35s,transform .35s;pointer-events:none}
  #dm-cap.on{opacity:1;transform:translateY(0)}
  html.dm-phone #dm-cap.top{top:12%;bottom:auto}
  html.dm-phone #dm-card p{font-size:16px}
  #dm-card .mail{display:block;margin-top:.6em;font-size:.85em;opacity:.85;word-break:break-all}
  #dm-cap small{display:block;font-weight:400;font-size:.72em;opacity:.85;margin-top:.15em}
  html.dm-side body.modal-open #dm-cap{margin:0;left:auto;right:3.5%;bottom:auto;top:50%;width:30vw;max-width:none;text-align:left;
    transform:translate(20px,-50%);font-size:30px;padding:.8em 1em}
  html.dm-side body.modal-open #dm-cap.on{transform:translate(0,-50%)}
  html.dm-side body.modal-open .modal-dialog{margin:1.2rem 0 1.2rem 9vw;zoom:1.22}
  #dm-tick{position:fixed;left:0;top:0;width:2px;height:2px;z-index:100003;pointer-events:none;background:rgba(0,0,0,.04);
    animation:dmtick .2s steps(2) infinite}
  @keyframes dmtick{from{transform:translateX(0)}to{transform:translateX(2px)}}
  #dm-cap b{color:#86efac}
  #dm-cap i{color:#fca5a5;font-style:normal}
  #dm-ptr{position:fixed;left:0;top:0;z-index:100002;pointer-events:none;transition:transform .7s cubic-bezier(.45,.05,.25,1);will-change:transform}
  #dm-ptr .ring{position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;border:3px solid rgba(250,204,21,.95);opacity:0}
  #dm-ptr .ring.go{animation:dmring .55s ease-out}
  @keyframes dmring{0%{opacity:1;transform:scale(.3)}100%{opacity:0;transform:scale(1.6)}}
  #dm-ptr .arrow{display:none;position:absolute;left:-3px;top:-2px;width:26px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}
  html.dm-side #dm-ptr .arrow{display:block}
  html.dm-side #dm-ptr .dot{display:none}
  #dm-ptr .dot{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.55);border:2px solid rgba(0,0,0,.35);box-shadow:0 2px 8px rgba(0,0,0,.3)}
  #dm-spot{position:fixed;z-index:99999;border-radius:10px;pointer-events:none;opacity:0;transition:opacity .4s,left .4s,top .4s,width .4s,height .4s;
    box-shadow:0 0 0 4px #facc15,0 0 0 9999px rgba(0,0,0,.45)}
  #dm-spot.on{opacity:1}
  #dm-card{position:fixed;inset:0;z-index:100001;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.4em;
    background:radial-gradient(circle at 30% 20%,#7b1f7a,#3b0a3a 70%);color:#fff;text-align:center;padding:6vw;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;opacity:0;transition:opacity .5s;pointer-events:none}
  #dm-card.on{opacity:1}
  #dm-card .k{font-size:var(--card-k,18px);letter-spacing:.14em;text-transform:uppercase;opacity:.75}
  #dm-card h1{font-size:var(--card-h,56px);font-weight:700;margin:0;line-height:1.1}
  #dm-card p{font-size:var(--card-p,24px);margin:.3em 0 0;opacity:.9;max-width:900px;line-height:1.4}
  #dm-prompt{position:fixed;left:0;right:0;bottom:0;z-index:100001;background:#fff;border-radius:16px 16px 0 0;padding:20px 20px 16px;
    box-shadow:0 -8px 30px rgba(0,0,0,.35);font-family:Roboto,-apple-system,"Segoe UI",sans-serif;color:#1f1f1f;
    transform:translateY(105%);transition:transform .45s cubic-bezier(.2,.8,.2,1)}
  #dm-prompt.on{transform:translateY(0)}
  #dm-prompt .site{font-size:13px;color:#5f6368;margin-bottom:6px}
  #dm-prompt .q{font-size:17px;font-weight:500;margin-bottom:18px}
  #dm-prompt .btns{display:flex;justify-content:flex-end;gap:10px}
  #dm-prompt .btns span{padding:9px 18px;border-radius:20px;font-weight:500;font-size:15px;color:#1a73e8}
  #dm-prompt .btns .allow{background:#1a73e8;color:#fff}
  #dm-note{position:fixed;left:3%;right:3%;top:2%;z-index:100001;background:rgba(255,255,255,.97);border-radius:18px;padding:12px 14px;
    box-shadow:0 8px 28px rgba(0,0,0,.3);font-family:Roboto,-apple-system,"Segoe UI",sans-serif;color:#1f1f1f;
    transform:translateY(-130%);transition:transform .5s cubic-bezier(.2,.8,.2,1)}
  #dm-note.on{transform:translateY(0)}
  #dm-note .app{display:flex;align-items:center;gap:7px;font-size:12px;color:#5f6368;margin-bottom:5px}
  #dm-note .app img{width:18px;height:18px;border-radius:4px}
  #dm-note .t{font-size:15px;font-weight:600;line-height:1.25}
  #dm-note .b{font-size:14px;color:#3c4043;margin-top:2px;line-height:1.3}
  #dm-photo{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:#111;opacity:0;transition:opacity .5s;pointer-events:none}
  #dm-photo.on{opacity:1}
  #dm-photo img{max-height:92%;max-width:92%;border-radius:6px;transform:scale(1);transition:transform 4s ease-out}
  #dm-photo.on img{transform:scale(1.08)}
  #dm-photo.fly img{transform:scale(.08) translate(var(--fx,0),var(--fy,0));transition:transform .7s ease-in;opacity:.2}
  `;
  const el = (id, html = '') => {
    let e = document.getElementById(id);
    if (!e) { e = document.createElement('div'); e.id = id; e.innerHTML = html; document.body.appendChild(e); }
    return e;
  };
  const ready = () => {
    if (window.__dmSide) document.documentElement.classList.add('dm-side');
    if (window.__dmPhone) document.documentElement.classList.add('dm-phone');
    if (document.getElementById('dm-style')) return;
    const s = document.createElement('style'); s.id = 'dm-style'; s.textContent = css; document.head.appendChild(s);
    // Something always moving, so the screencast keeps sending frames (it sends only on change).
    el('dm-tick');
    el('dm-ptr', '<div class="dot"></div><div class="ring"></div><svg class="arrow" viewBox="0 0 20 28"><path d="M1 1 L1 22 L6.5 17 L10.5 26 L14 24.5 L10 15.8 L17 15.8 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>');
  };
  let spotTarget = null, lastRect = '';
  // Writes only when the target moved: rewriting the 9999px-shadow box every frame is enough
  // to starve headless Chrome's software compositor, which then stops sending frames.
  const track = () => {
    const spot = document.getElementById('dm-spot');
    if (spot && spotTarget) {
      const r = spotTarget.getBoundingClientRect(), p = 8;
      const key = [r.left, r.top, r.width, r.height].map(Math.round).join();
      if (key !== lastRect) {
        lastRect = key;
        Object.assign(spot.style, { left: r.left - p + 'px', top: r.top - p + 'px', width: r.width + 2 * p + 'px', height: r.height + 2 * p + 'px' });
      }
    }
    requestAnimationFrame(track);
  };
  requestAnimationFrame(track);
  return {
    ready,
    caption(html) {
      ready(); const c = el('dm-cap');
      if (!html) { c.classList.remove('on'); return; }
      // On a phone the caption goes in whichever half the highlighted thing is not in;
      // with nothing highlighted, at the top while the wizard is open.
      const placeIt = () => {
        let top = document.body.classList.contains('modal-open');
        if (spotTarget) { const r = spotTarget.getBoundingClientRect(); top = (r.top + r.bottom) / 2 > innerHeight * 0.45; }
        c.classList.toggle('top', top);
      };
      if (c.classList.contains('on')) {
        c.classList.remove('on');
        setTimeout(() => { c.innerHTML = html; placeIt(); c.classList.add('on'); }, 300);
      } else { c.innerHTML = html; placeIt(); requestAnimationFrame(() => c.classList.add('on')); }
    },
    pointer(x, y) { ready(); el('dm-ptr').style.transform = `translate(${x}px,${y}px)`; },
    tapRing() { const r = document.querySelector('#dm-ptr .ring'); r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); },
    spot(selector) {
      ready(); const s = el('dm-spot');
      if (!selector) { s.classList.remove('on'); spotTarget = null; return; }
      spotTarget = [...document.querySelectorAll(selector)].find(e => e.offsetParent !== null) || document.querySelector(selector);
      s.classList.add('on');
    },
    card(kicker, title, sub) {
      ready(); const c = el('dm-card');
      if (title == null) { c.classList.remove('on'); return; }
      if (window.__dmCardBg) c.style.background = window.__dmCardBg;
      c.innerHTML = `<div class="k">${kicker}</div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}`;
      requestAnimationFrame(() => c.classList.add('on'));
    },
    // A stand-in for the browser's own permission prompt, which a headless recording cannot show.
    prompt(site) {
      ready(); const p = el('dm-prompt');
      if (!site) { p.classList.remove('on'); return; }
      p.innerHTML = `<div class="site">${site}</div><div class="q">Allow ${site} to send notifications?</div>` +
        '<div class="btns"><span class="block">Block</span><span class="allow">Allow</span></div>';
      requestAnimationFrame(() => p.classList.add('on'));
    },
    // A stand-in for a delivered notification, as it drops in at the top of a phone screen.
    notify(title, body, icon) {
      ready(); const n = el('dm-note');
      if (!title) { n.classList.remove('on'); return; }
      const fill = () => {
        n.innerHTML = `<div class="app"><img src="${icon || '/touch-icon-192x192.png'}">${window.__dmApp || document.title} · now</div>` +
          `<div class="t">${title}</div><div class="b">${body || ''}</div>`;
        requestAnimationFrame(() => n.classList.add('on'));
      };
      if (n.classList.contains('on')) { n.classList.remove('on'); setTimeout(fill, 550); } else fill();
    },
    photo(src, on) {
      ready(); const p = el('dm-photo', `<img src="${src}">`);
      if (on === 'fly') { p.classList.add('fly'); setTimeout(() => p.classList.remove('on'), 500); return; }
      if (on) requestAnimationFrame(() => p.classList.add('on')); else p.classList.remove('on', 'fly');
    },
  };
})();
document.addEventListener('DOMContentLoaded', () => window.__demo.ready());

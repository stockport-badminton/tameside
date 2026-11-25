// The /notifications opt-in (views/notifications.ejs). Verbatim from Stockport (league-site
// 1a5f9d2), which ported it from the Hyde club site's
// push-panel.js. The server's record of this browser's subscription is the truth: the page
// asks for it (POST /api/push/subscription) rather than remembering choices locally.
(function () {
  'use strict';

  var panel = document.getElementById('push-panel');
  if (!panel) return;
  var vapidKey = panel.getAttribute('data-vapid-key');
  var $ = function (sel) { return panel.querySelector(sel); };
  var boxes = function (name) { return Array.prototype.slice.call(panel.querySelectorAll('input[name="' + name + '"]')); };
  var subscribeBtn = $('[data-action="subscribe"]');
  var unsubscribeBtn = $('[data-action="unsubscribe"]');
  var intro = $('[data-role="intro"]');
  var status = $('[data-role="status"]');
  // /notifications?team=N preselects that team; saved choices don't override it.
  var teamFromLink = new URLSearchParams(location.search).has('team');

  function show(state) {
    panel.querySelectorAll('[data-state]').forEach(function (el) {
      el.hidden = el.getAttribute('data-state') !== state;
    });
  }

  function setStatus(msg, error) {
    status.textContent = msg;
    status.className = 'mt-2 mb-0 ' + (error ? 'text-danger' : 'text-success');
  }

  function checked(name) {
    return boxes(name).filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
  }

  // "2 followed" beside each club, so a collapsed club still shows what is ticked inside it.
  function updateClubCounts() {
    panel.querySelectorAll('details').forEach(function (d) {
      var n = d.querySelectorAll('input[name="push-team"]:checked').length;
      d.querySelector('[data-role="club-count"]').textContent = n ? '(' + n + ' followed)' : '';
    });
  }

  function apply(saved) {
    if (!teamFromLink && saved.teams && saved.teams.length) {
      boxes('push-team').forEach(function (b) {
        b.checked = saved.teams.indexOf(Number(b.value)) !== -1;
        if (b.checked) b.closest('details').open = true;
      });
    }
    if (saved.types && saved.types.length) {
      boxes('push-type').forEach(function (b) { b.checked = saved.types.indexOf(b.value) !== -1; });
    }
    updateClubCounts();
  }

  function urlBase64ToUint8Array(base64) {
    var padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), function (c) { return c.charCodeAt(0); });
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function render(subscribed) {
    intro.textContent = subscribed
      ? 'Notifications are on for this device. Change what you get below.'
      : 'Choose the teams you want to hear about on this device.';
    subscribeBtn.textContent = subscribed ? 'Save settings' : 'Turn on notifications';
    unsubscribeBtn.hidden = !subscribed;
    show('ready');
  }

  async function init() {
    if (!vapidKey) return show('unavailable');
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      var iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
      return show(iOS && !standalone ? 'ios-install' : 'unsupported');
    }
    if (Notification.permission === 'denied') return show('denied');

    // pwa-head.ejs registers the worker on window 'load'; wait briefly for it.
    var reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 6000); })
    ]);
    if (!reg) return show('unsupported');

    panel.addEventListener('change', updateClubCounts);

    var sub = await reg.pushManager.getSubscription();
    var subscribed = false;
    if (sub) {
      try {
        var saved = await api('POST', '/api/push/subscription', { endpoint: sub.endpoint });
        subscribed = !!saved.subscribed;
        if (subscribed) apply(saved);
      } catch (e) { /* shown as not subscribed; saving again repairs it */ }
    }
    updateClubCounts();
    render(subscribed);

    subscribeBtn.addEventListener('click', async function () {
      var prefs = { teams: checked('push-team').map(Number), types: checked('push-type') };
      if (!prefs.teams.length) return setStatus('Pick at least one team.', true);
      if (!prefs.types.length) return setStatus('Pick results, reminders or both — or use Turn off.', true);
      subscribeBtn.disabled = true;
      try {
        var wasOn = !unsubscribeBtn.hidden;
        if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
          return show(Notification.permission === 'denied' ? 'denied' : 'ready');
        }
        var s = (await reg.pushManager.getSubscription()) ||
          (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) }));
        await api('POST', '/api/push/subscribe', { subscription: s.toJSON(), teams: prefs.teams, types: prefs.types });
        render(true);
        setStatus(wasOn ? 'Settings saved.' : 'Notifications are on.');
      } catch (err) {
        setStatus('Couldn’t save notification settings: ' + err.message, true);
      } finally {
        subscribeBtn.disabled = false;
      }
    });

    unsubscribeBtn.addEventListener('click', async function () {
      unsubscribeBtn.disabled = true;
      try {
        var s = await reg.pushManager.getSubscription();
        if (s) {
          await api('DELETE', '/api/push/subscribe', { endpoint: s.endpoint }).catch(function () {});
          await s.unsubscribe();
        }
        render(false);
        setStatus('Notifications are off.');
      } catch (err) {
        setStatus('Couldn’t turn off notifications: ' + err.message, true);
      } finally {
        unsubscribeBtn.disabled = false;
      }
    });
  }

  init().catch(function () { show('unsupported'); });
})();

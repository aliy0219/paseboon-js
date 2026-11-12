// Settings window logic. Talks to the main process only through window.paseboon.
(() => {
  const api = window.paseboon;
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const NUMERIC = ['idleThreshold', 'absentChecksToLock', 'recheckEvery', 'activeCheckEvery',
    'strangerChecksToLock', 'cameraFailIdle', 'unlockGrace', 'matchThreshold'];
  const INTEGER = new Set(['absentChecksToLock', 'strangerChecksToLock']);
  let current = null;

  const show = (el, text, kind = '') => {
    el.textContent = text;
    el.className = `result ${kind}`;
  };

  function fill(settings) {
    form.elements.mode.value = settings.mode;
    for (const k of NUMERIC) form.elements[k].value = settings[k];
  }

  function render(state) {
    current = state;
    $('status').textContent = state.status;
    const box = $('warnings');
    box.replaceChildren(...state.warnings.map((w) => {
      const p = document.createElement('p');
      p.className = 'warning';
      p.textContent = `⚠ ${w}`;
      return p;
    }));
    $('pause').textContent = state.paused ? 'Resume watching' : 'Pause watching';
    $('pause').disabled = !state.enrolled;
    $('login').checked = state.loginItem;
    $('enrolled').textContent = state.enrolled
      ? `${state.enrolled} face samples enrolled (numbers only, no photos).`
      : 'No face enrolled yet. Both modes need it.';
    $('enroll-add').disabled = !state.enrolled;
    $('test-camera').disabled = !state.enrolled;
    $('log').textContent = state.logFile;
  }

  async function busy(button, fn) {
    const all = document.querySelectorAll('button');
    all.forEach((b) => { b.disabled = true; });
    try {
      return await fn();
    } finally {
      all.forEach((b) => { b.disabled = false; });
      if (current) render(current);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const partial = { mode: form.elements.mode.value };
    for (const k of NUMERIC) {
      const v = Number(form.elements[k].value);
      partial[k] = INTEGER.has(k) ? Math.round(v) : v;
    }
    const res = await api.saveSettings(partial);
    show($('form-result'), res.error ? res.error : 'Saved.', res.error ? 'bad' : 'good');
  });

  $('reset').addEventListener('click', () => current && fill(current.defaults));

  $('pause').addEventListener('click', () => busy($('pause'), async () => {
    const res = await api.setPaused(!current.paused);
    if (res.error) show($('face-result'), res.error, 'bad');
  }));

  $('login').addEventListener('change', async (e) => {
    const res = await api.setLoginItem(e.target.checked);
    if (res.error) {
      e.target.checked = false;
      show($('form-result'), res.error, 'bad');
    }
  });

  const runEnroll = (add) => busy(null, async () => {
    show($('face-result'), 'Starting camera…');
    const res = await api.enroll(add);
    if (res.error) return show($('face-result'), res.error, 'bad');
    const low = res.minSimilarity < res.threshold;
    show($('face-result'),
      `Saved ${res.count} samples. Self-similarity min ${res.minSimilarity.toFixed(3)}, median `
      + `${res.medianSimilarity.toFixed(3)} (threshold ${res.threshold}).`
      + (low ? ' Some samples are below the threshold: re-enroll in better light.' : ''),
      low ? 'bad' : 'good');
  });
  $('enroll').addEventListener('click', () => runEnroll(false));
  $('enroll-add').addEventListener('click', () => runEnroll(true));

  $('test-camera').addEventListener('click', () => busy(null, async () => {
    show($('face-result'), 'Camera on for up to 3 s…');
    const res = await api.testCamera();
    if (res.error) return show($('face-result'), res.error, 'bad');
    show($('face-result'), `${res.summary}\nAn idle check in ${res.mode} mode would treat this as ${res.verdict}.`,
      res.verdict === 'PRESENT' ? 'good' : 'bad');
  }));

  $('test-lock').addEventListener('click', () => busy(null, async () => {
    const res = await api.testLock();
    if (res.cancelled) return show($('lock-result'), 'Cancelled.');
    if (res.error) return show($('lock-result'), res.error, 'bad');
    show($('lock-result'), `Result: ${res.result}`, /FAILED/.test(res.result) ? 'bad' : 'good');
  }));

  // ── USB guard ───────────────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const deviceItem = (d, button) => {
    const li = el('li');
    const info = el('div');
    info.append(el('div', '', d.name), el('div', 'meta', `${d.ids}${d.serial ? ' · has serial' : ''}`));
    li.append(info);
    if (button) li.append(button);
    return li;
  };
  const btn = (text, cls, onClick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const empty = (text) => el('li', 'muted', text);

  function renderUsb(u) {
    if (!u || u.error) return;
    $('usb-guard').checked = u.enabled;
    $('usb-photo').checked = u.photo;
    $('usb-photo').disabled = !u.enabled;
    $('usb-status').textContent = !u.enabled ? 'Off.'
      : `${u.running ? 'Running' : 'Not running'} · checks every 0.5 s · photo ${u.photo ? `on (${u.timing.replace('_', ' ')})` : 'off'}`;
    $('usb-warning').hidden = !u.warning;
    $('usb-warning').textContent = u.warning ? `⚠ ${u.warning}` : '';

    const conn = $('usb-connected');
    conn.replaceChildren(...(u.connectedError ? [empty(`Cannot list USB devices: ${u.connectedError}`)]
      : u.connected.length ? u.connected.map((d) => {
        const li = deviceItem(d, d.trusted ? null : btn('Trust', 'secondary', () => act(api.usbTrust(d.key))));
        li.firstChild.append(el('span', d.trusted ? 'tag' : 'tag bad', d.trusted ? 'trusted' : 'untrusted'));
        return li;
      }) : [empty('No USB devices connected.')]));

    $('usb-trusted').replaceChildren(...(u.trusted.length
      ? u.trusted.map((d) => deviceItem(d, btn('Remove', 'danger', () => act(api.usbUntrust(d.key)))))
      : [empty('Nothing trusted yet: every newly plugged device will lock the screen.')]));

    $('usb-events').replaceChildren(...(u.events.length ? u.events.flatMap((e) => e.devices.map((d) => {
      const when = new Date(e.time).toLocaleString();
      const li = deviceItem(d, d.trusted ? null : btn('Trust this device', 'secondary', () => act(api.usbTrust(d.key))));
      li.firstChild.append(el('div', 'meta', `${when} · lock ${e.lock}${e.photo ? ' · photo taken' : ''}`));
      return li;
    })) : [empty('No USB locks yet.')]));

    $('photo-count').textContent = `${u.photoCount} photo(s) stored (newest 50 kept): ${u.photosDir}`;
    $('photos-delete').disabled = u.photoCount === 0;
  }

  async function act(promise) {
    const res = await promise;
    if (res?.error) show($('usb-result'), res.error, 'bad');
    else if (res?.cancelled) show($('usb-result'), 'Cancelled.');
    else if (res && 'deleted' in res) show($('usb-result'), `Deleted ${res.deleted} photo(s).`, 'good');
    renderUsb(res && 'trusted' in res ? res : await api.usbState());
  }

  $('usb-guard').addEventListener('change', (e) => act(api.saveSettings({ usbGuard: e.target.checked })));
  $('usb-photo').addEventListener('change', (e) => act(api.saveSettings({ usbPhoto: e.target.checked })));
  $('usb-trust-connected').addEventListener('click', () => act(api.usbTrustConnected()));
  $('photos-open').addEventListener('click', () => act(api.photosOpenFolder()));
  $('photos-delete').addEventListener('click', () => act(api.photosDeleteAll()));
  api.usbState().then(renderUsb);
  setInterval(() => { if (!document.hidden) api.usbState().then(renderUsb); }, 3000);

  api.onEnrollProgress((p) => {
    show($('face-result'), `Sample ${p.count}/${p.total}${p.hint ? ` — ${p.hint}` : ''}`);
  });
  api.onState(render);
  api.getState().then((s) => {
    render(s);
    fill(s.settings);
  });
})();

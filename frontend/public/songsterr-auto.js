// Songsterr page automation, used by the hidden window of the exe (Electron) and the apk (Android).
// It is injected into the song page; exposes window.__drumheroAuto with:
//   check()      -> { loggedIn, hasPlus, name }  (state the site itself sends in the page)
//   exportGp()   -> clicks download -> Guitar Pro (the download is captured by the app)
// The selectors are the same ones that worked in the old version (the site's #control-export button).
// Message language: window.__drumheroLang ('en' default, 'pt').
(function () {
  // Keeps the files the page generates (blob:) and delays releasing them: the site revokes the link right
  // after the download click, and on Android the app can only read the file a moment later.
  if (!window.__dhBlobs) {
    window.__dhBlobs = {};
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function (o) {
      const u = create(o);
      try { if (o instanceof Blob) window.__dhBlobs[u] = o; } catch (e) { /* ignore */ }
      return u;
    };
    URL.revokeObjectURL = function (u) { setTimeout(function () { revoke(u); delete window.__dhBlobs[u]; }, 120000); };
  }
  // Android: the app receives the file straight from the page (the WebView doesn't always report a blob:/data: download).
  // This doesn't run in the exe: there the download is captured by Electron itself.
  if (window.DrumHeroBridge && !window.__dhGrab) {
    window.__dhGrab = true;
    const sendBlob = (blob, name) => {
      const f = new FileReader();
      f.onload = () => window.DrumHeroBridge.file(name || 'song.gp', String(f.result).split(',')[1]);
      f.readAsDataURL(blob);
    };
    const grab = (href, name) => {
      if (!href) return false;
      if (href.startsWith('blob:') && window.__dhBlobs[href]) { sendBlob(window.__dhBlobs[href], name); return true; }
      if (href.startsWith('data:') && href.includes(';base64,')) { window.DrumHeroBridge.file(name || 'song.gp', href.split(';base64,')[1]); return true; }
      return false;
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (grab(this.href, this.getAttribute('download'))) return;
      return click.call(this);
    };
    document.addEventListener('click', e => {
      const a = e.target && e.target.closest && e.target.closest('a[href^="blob:"], a[href^="data:"]');
      if (a && grab(a.href, a.getAttribute('download'))) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    const open = window.open;
    window.open = function (u) {
      if (typeof u === 'string' && grab(u, '')) return null;
      return open.apply(window, arguments);
    };
  }
  if (window.__drumheroAuto) return;
  const tr = (en, pt) => (window.__drumheroLang === 'pt' ? pt : en);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.offsetParent !== null && !el.disabled;
  const byText = (sel, re) => Array.from(document.querySelectorAll(sel)).find(el =>
    visible(el) && re.test(((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim()));
  const first = list => list.map(f => f()).find(visible) || null;

  const findOpen = () => first([
    () => document.querySelector('#control-export'),
    () => byText('button, [role=button]', /baixar a tab|download|export/i),
  ]);
  const findGp = () => first([
    () => document.querySelector('#control-export-gp'),
    () => document.querySelector("[id*='export-gp'], [id*='export-guitar'], [data-format='gp']"),
    () => byText('button, [role=button], [role=menuitem], a', /guitar ?pro|\.gp\b/i),
  ]);
  const findConfirm = () => byText('button, [role=button]', /^(baixar|download|exportar|export)$/i);

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const el = fn();
      if (el) return el;
      await sleep(80);
    }
    return null;
  }

  function readState() {
    try {
      const s = document.getElementById('state');
      return s ? JSON.parse(s.textContent || 'null') : null;
    } catch { return null; }
  }

  window.__drumheroAuto = {
    async check() {
      // the state comes in the page HTML (wait for it to appear)
      for (let i = 0; i < 100 && !readState(); i++) await sleep(100);
      const user = (readState() || {}).user || {};
      return { loggedIn: !!user.isLoggedIn, hasPlus: !!user.hasPlus, name: (user.profile && user.profile.name) || '' };
    },
    async exportGp() {
      const open = await waitFor(findOpen, 25000);
      if (!open) throw new Error(tr("Songsterr's export button was not found", 'botão de exportar do Songsterr não encontrado'));
      if (!findGp()) open.click();      // the menu may already be open (clicking again would close it)
      const gp = await waitFor(findGp, 8000);
      if (!gp) throw new Error(tr('Guitar Pro option not found in the Songsterr menu', 'opção Guitar Pro não encontrada no menu do Songsterr'));
      gp.click();
      // if the site asks for confirmation, confirm
      const confirm = await waitFor(findConfirm, 2000);
      if (confirm) confirm.click();
      return { clicked: true };
    },
  };
})();

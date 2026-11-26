// OpenDrumHero for Windows and Linux (AppImage). The app is the same Angular app as the apk (app/ folder, copied from frontend/dist by
// scripts\build-exe.ps1). This program (Electron) stays in the background and handles the system side:
//  - serve the app at a fixed local address (http://localhost:47821);
//  - GAME WINDOW IN THE PC'S DEFAULT BROWSER. If it is Chromium-based (Chrome, Edge, Brave, Vivaldi…),
//    in "app mode" (its own window, no address bar), in its normal profile; another browser (Firefox…)
//    opens the game as a normal page. (YouTube refuses music videos inside Electron and on an IP address
//    like http://127.0.0.1 — error 150; in a browser on localhost they play.) If the browser doesn't open
//    the game, it opens in Electron's own window;
//  - keep the library and the settings in files (config/ and library/ folders, next to the exe), so they
//    don't depend on the browser's storage (see "data on disk" below);
//  - Songsterr import in a hidden window (login only shows up when needed; requires Plus). The game,
//    in the browser, talks to this part through /api on the same local address (with a secret key).
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORTS = [47821, 47822, 47823];
const APP_DIR = path.join(__dirname, 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.sf2': 'application/octet-stream', '.txt': 'text/plain',
};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;

// texts this program shows in the app (language chosen there: 'en' default, 'pt' alternative)
let lang = 'en';
const MSG = {
  portsBusy: ['ports 47821-47823 are busy', 'portas 47821-47823 ocupadas'],
  loginTimeout: ['the Songsterr login was not completed in time', 'o login no Songsterr não foi concluído a tempo'],
  loginClosed: ['Songsterr login canceled (the window was closed)', 'login no Songsterr cancelado (a janela foi fechada)'],
  notLogged: ['you are not logged in to Songsterr: sign in on the window that opened', 'você não está logado no Songsterr: entre na sua conta na janela que abriu'],
  busy: ['a Songsterr import is already running', 'já existe uma importação do Songsterr em andamento'],
  opening: ['opening the song on Songsterr', 'abrindo a música no Songsterr'],
  loggedIn: ['logged in; opening the song again', 'login feito; abrindo a música de novo'],
  notRecognized: ["Songsterr didn't recognize the login yet; try importing again", 'o Songsterr ainda não reconheceu o login; tente importar de novo'],
  noPlus: ['the Songsterr account{name} has no Plus: Guitar Pro download is a Songsterr Plus feature. Subscribe to Plus or import a Guitar Pro file manually.',
           'a conta do Songsterr{name} não tem Plus: o download de Guitar Pro é recurso do Songsterr Plus. Assine o Plus ou importe um arquivo Guitar Pro manualmente.'],
  downloading: ['downloading the Guitar Pro file', 'baixando o Guitar Pro'],
  timeout: ["Songsterr didn't deliver the Guitar Pro file in time", 'o Songsterr não entregou o Guitar Pro a tempo'],
  canceled: ['import canceled', 'importação cancelada'],
  received: ['Guitar Pro received; building the song', 'Guitar Pro recebido; montando a música'],
  loginTitle: ['Sign in to your Songsterr account', 'Entre na sua conta do Songsterr'],
  unauthorized: ['not allowed', 'sem permissão'],
  unknownRoute: ['unknown route', 'rota desconhecida'],
  jobNotFound: ['import not found', 'importação não encontrada'],
  songNotFound: ['song not found', 'música não encontrada'],
};
function tr(key, params = {}) {
  let s = MSG[key][lang === 'pt' ? 1 : 0];
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(v);
  return s;
}

const API_TOKEN = crypto.randomBytes(24).toString('hex');
let lastAlive = 0;

let httpServer = null;
let httpServer6 = null;

/** Host header of a request to this server: only localhost / 127.0.0.1 / [::1] on the port it listens on. */
function allowedHost(req) {
  const port = req.socket.localPort;
  const host = String(req.headers.host || '').toLowerCase();
  return host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}`;
}

/** Origin of a request sent by a page: if it says one, it must be this server's own address. */
function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const port = req.socket.localPort;
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}` || origin === `http://[::1]:${port}`;
}

function serveApp() {
  const handler = (req, res) => {
    // only this PC's own addresses: a site that points its domain at 127.0.0.1 ("DNS rebinding") would
    // otherwise be able to read the page — and the secret key that goes in it
    if (!allowedHost(req)) { res.writeHead(403); res.end(); return; }
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
    if (url.startsWith('/api/')) { void handleApi(req, res, url); return; }
    let file = path.normalize(path.join(APP_DIR, url));
    if (!file.startsWith(APP_DIR)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) file = path.join(APP_DIR, 'index.html');   // app routes (SPA)
      fs.readFile(file, (e, data) => {
        if (e) { res.writeHead(404); res.end(); return; }
        if (file.endsWith('index.html')) {
          // the game in the browser knows it is running from the exe and gets the key to talk to /api
          const info = { token: API_TOKEN, version: app.getVersion() };
          data = Buffer.from(String(data).replace('</head>',
            `<script>window.__drumheroDesktop=${JSON.stringify(info)}</script></head>`));
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                             'Cache-Control': 'no-cache' });
        res.end(data);
      });
    });
  };
  const server = http.createServer(handler);
  httpServer = server;
  return new Promise((resolve, reject) => {
    const tryPort = i => {
      if (i >= PORTS.length) { reject(new Error(tr('portsBusy'))); return; }
      server.once('error', () => tryPort(i + 1));
      server.listen(PORTS[i], '127.0.0.1', () => {
        // "localhost" can also resolve to ::1 (IPv6): listen there too, if possible
        const v6 = http.createServer(handler);
        v6.on('error', () => {});
        v6.listen(PORTS[i], '::1');
        httpServer6 = v6;
        resolve(PORTS[i]);
      });
    };
    tryPort(0);
  });
}

// ---------------------------------------------------------------------------- /api (game in the browser)
// Only accepts requests with the secret key (X-DrumHero-Token header), which only the game page receives:
// other sites open on the PC can't use these routes.

const jobs = new Map();   // Songsterr imports: id -> { messages, done, error, result }

function readBody(req, limit = 1e6) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const b64 = data => (data ? Buffer.from(data).toString('base64') : undefined);

let byeTimer = null;

async function handleApi(req, res, url) {
  if (!allowedOrigin(req)) { sendJson(res, 403, { error: tr('unauthorized') }); return; }
  if (url === '/api/bye' && req.method === 'POST') {
    // the game window closed (sendBeacon sends no headers: the key comes in the body). Wait a few
    // seconds: if it was just a reload (F5), the new page sends a heartbeat and nothing quits.
    const body = await readBody(req);
    if (body.token === API_TOKEN) {
      clearTimeout(byeTimer);
      byeTimer = setTimeout(() => { if (!current && !mainWindow) app.quit(); }, 5000);
    }
    res.writeHead(204); res.end();
    return;
  }
  if (req.headers['x-drumhero-token'] !== API_TOKEN) { sendJson(res, 403, { error: tr('unauthorized') }); return; }
  lastAlive = Date.now();
  clearTimeout(byeTimer);
  const q = new URL(req.url, 'http://x').searchParams;
  try {
    if (url === '/api/alive') { sendJson(res, 200, { ok: true }); return; }
    if (url === '/api/songsterr/start' && req.method === 'POST') {
      const { url: songUrl, lang: songLang } = await readBody(req);
      if (songLang) lang = songLang;
      const id = crypto.randomBytes(8).toString('hex');
      const job = { messages: [], done: false, error: null, result: null };
      jobs.set(id, job);
      fetchSongsterr(String(songUrl || ''), msg => job.messages.push(msg))
        .then(r => { job.result = { url: r.url, gp: b64(r.gp), gpName: r.gpName, mid: b64(r.mid), videoPoints: r.videoPoints }; })
        .catch(e => { job.error = String(e?.message || e); })
        .finally(() => { job.done = true; setTimeout(() => jobs.delete(id), 5 * 60 * 1000); });
      sendJson(res, 200, { id });
      return;
    }
    if (url === '/api/songsterr/poll') {
      const job = jobs.get(q.get('id') || '');
      if (!job) { sendJson(res, 404, { error: tr('jobNotFound') }); return; }
      const from = Number(q.get('from')) || 0;
      sendJson(res, 200, { messages: job.messages.slice(from), done: job.done, error: job.error, result: job.done ? job.result : null });
      return;
    }
    if (url === '/api/songsterr/cancel' && req.method === 'POST') { current?.cancel?.(); sendJson(res, 200, { ok: true }); return; }
    if (url === '/api/settings') {
      if (req.method === 'POST') { saveSettings(await readBody(req, 5e6)); sendJson(res, 200, { ok: true }); return; }
      sendJson(res, 200, readSettings());
      return;
    }
    if (url === '/api/library') { sendJson(res, 200, { songs: listLibrary() }); return; }
    const song = /^\/api\/library\/([^/]+)$/.exec(url);
    if (song) {
      const id = song[1];
      if (!SONG_ID.test(id)) { sendJson(res, 400, { error: tr('unknownRoute') }); return; }
      if (req.method === 'POST' && q.get('delete') === '1') { deleteLibrarySong(id); sendJson(res, 200, { ok: true }); return; }
      if (req.method === 'POST') { writeLibrarySong(id, await readBody(req, 200e6)); sendJson(res, 200, { ok: true }); return; }
      const data = readLibrarySong(id);
      if (!data) { sendJson(res, 404, { error: tr('songNotFound') }); return; }
      sendJson(res, 200, data);
      return;
    }
    sendJson(res, 404, { error: tr('unknownRoute') });
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message || e) });
  }
}

function cleanUserAgent(ua) {
  return ua.replace(/\s(Electron|drumhero-desktop|DrumHero|OpenDrumHero)\/\S+/gi, '');
}

function allowDevicePermissions(ses) {
  // Electron asks for 'midiSysex' for Web MIDI even without sysex
  const allowed = new Set(['midi', 'midiSysex', 'fullscreen', 'media', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

/** Game window in Electron itself (fallback: when the default browser doesn't open the game, or with --electron-window). */
async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1366, height: 820, minWidth: 900, minHeight: 560,
    backgroundColor: '#05080e', autoHideMenuBar: true, title: 'OpenDrumHero',
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  mainWindow.removeMenu();
  // F11 = fullscreen (the game runs smoother fullscreen than windowed)
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      e.preventDefault();
    }
  });
  // external links open in the Windows browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  await mainWindow.loadURL(gameUrl(port));
}

// --------------------------------------------------------------------- game in the installed browser

/** Chromium-based browsers: accept --app (own window, no address bar). */
const CHROMIUM_EXE = /^(chrome|msedge|brave|vivaldi|chromium|thorium|yandex)$/i;

/**
 * The PC's default browser (the one that opens links). First through the system API (the same one Windows uses
 * to open a link: it also understands the newer Windows 11 registry), then through the registry directly.
 * Returns { name, path, chromium } or null if it can't be found. Writes what it found to
 * config/browser.log (for diagnostics).
 */
async function defaultBrowser() {
  if (process.platform === 'linux') return linuxDefaultBrowser();
  if (process.platform !== 'win32') {   // tests outside Windows and Linux
    const b = findBrowser();
    return b && { ...b, chromium: true };
  }
  const log = [];
  const result = exe => {
    const name = path.basename(exe).replace(/\.exe$/i, '');
    const r = { name, path: exe, chromium: CHROMIUM_EXE.test(name) };
    log.push(`-> ${JSON.stringify(r)}`);
    return r;
  };
  try {
    try {
      const info = await app.getApplicationInfoForProtocol('https://www.youtube.com/');
      log.push(`api: ${JSON.stringify({ name: info?.name, path: info?.path })}`);
      if (info?.path && /\.exe$/i.test(info.path) && fs.existsSync(info.path)) return result(info.path);
    } catch (e) { log.push(`api failed: ${e?.message || e}`); }
    const reg = args => execFileSync('reg', ['query', ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    let progId = null;
    for (const proto of ['https', 'http']) {
      try {
        // UserChoiceLatest (newer Windows 11) and UserChoice: take whichever ProgId shows up, the newer one first
        const out = reg([`HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${proto}`, '/s']);
        log.push(`reg ${proto}: ${out.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
        const latest = /UserChoiceLatest[\s\S]*?ProgId\s+REG_SZ\s+(\S+)/i.exec(out)?.[1];
        progId = latest || /ProgId\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] || null;
      } catch { /* no choice for this protocol */ }
      if (progId) break;
    }
    if (!progId) return null;
    const cmd = reg([`HKCR\\${progId}\\shell\\open\\command`, '/ve']);
    log.push(`cmd: ${cmd.replace(/\s+/g, ' ').trim()}`);
    const m = /REG_(?:EXPAND_)?SZ\s+(?:"([^"]+)"|(.+?\.exe)\b)/i.exec(cmd);
    if (!m) return null;
    const exe = (m[1] || m[2]).replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
    return fs.existsSync(exe) ? result(exe) : null;
  } catch (e) {
    log.push(`error: ${e?.message || e}`);
    return null;
  } finally {
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(path.join(configDir(), 'browser.log'), `${new Date().toISOString()}\n${log.join('\n')}\n`);
    } catch { /* ok */ }
  }
}

/** Installed Chromium-based browser outside Windows (development and tests). */
function findBrowser() {
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/brave', '/usr/bin/brave-browser', '/usr/bin/vivaldi-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (fs.existsSync(p)) return { name: path.basename(p), path: p };
  }
  return null;
}

/**
 * Linux: the default browser from xdg-settings (e.g. "brave-browser.desktop", "com.brave.Browser.desktop" for
 * Flatpak, "firefox.desktop"), started through the Exec line of its .desktop file. Returns { name, path, args,
 * chromium } or null (then the link opens with xdg-open). Writes what it found to config/browser.log.
 */
function linuxDefaultBrowser() {
  const log = [];
  try {
    let id = '';
    try { id = execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8', timeout: 5000 }).trim(); }
    catch (e) { log.push(`xdg-settings failed: ${e?.message || e}`); }
    log.push(`xdg-settings: ${id}`);
    const exec = id && desktopExec(id);
    log.push(`exec: ${JSON.stringify(exec)}`);
    if (exec?.length) {
      const name = id.replace(/\.desktop$/, '');
      const r = { name, path: exec[0], args: exec.slice(1), chromium: /chrom|brave|vivaldi|edge|thorium|yandex|opera/i.test(name) };
      log.push(`-> ${JSON.stringify(r)}`);
      return r;
    }
    const b = findBrowser();   // no default set: an installed Chromium-based browser, if any
    log.push(`fallback: ${JSON.stringify(b)}`);
    return b && { ...b, chromium: true };
  } finally {
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(path.join(configDir(), 'browser.log'), `${new Date().toISOString()}\n${log.join('\n')}\n`);
    } catch { /* ok */ }
  }
}

/** Command of a .desktop file (searched in the XDG data folders), without the %u/%U/@@ placeholders. */
function desktopExec(id) {
  const home = os.homedir();
  const dirs = [process.env.XDG_DATA_HOME || path.join(home, '.local/share'),
    ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'),
    path.join(home, '.local/share/flatpak/exports/share'), '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop'];
  for (const d of dirs) {
    const file = path.join(d, 'applications', id);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const main = text.split(/^\[(?!Desktop Entry\])/m)[0];   // only the [Desktop Entry] group
    const line = /^Exec=(.*)$/m.exec(main)?.[1];
    if (!line) continue;
    const tokens = [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(m => m[1] ?? m[2])
      .filter(t => !/^%[a-zA-Z]$/.test(t) && !/^@@[a-z]?$/.test(t));
    if (tokens.length) return tokens;
  }
  return null;
}

let browserProc = null;

// The game opens at http://localhost:<port>. At http://127.0.0.1 YouTube refuses music videos (error 150):
// it doesn't accept an IP address as the site embedding the video; "localhost" works.
const gameUrl = port => `http://localhost:${port}/`;

function openInBrowser(browser, port) {
  // browser's normal profile (no --user-data-dir), in "app mode": own window, no address bar or tabs
  const args = [...(browser.args || []), `--app=${gameUrl(port)}`, '--window-size=1366,820'];
  if (process.env.DRUMHERO_BROWSER_PROFILE) args.push(`--user-data-dir=${process.env.DRUMHERO_BROWSER_PROFILE}`, '--no-first-run');   // tests
  if (process.env.DRUMHERO_BROWSER_DEBUG_PORT) args.push(`--remote-debugging-port=${process.env.DRUMHERO_BROWSER_DEBUG_PORT}`);   // tests
  const started = Date.now();
  const proc = spawn(browser.path, args, { detached: false, stdio: 'ignore' });
  browserProc = proc;
  proc.on('error', e => { console.error(e); void createWindow(port); });
  proc.on('exit', () => {
    if (browserProc !== proc) return;
    browserProc = null;
    // window closed: quit. (If the browser handed the window to an already running process, the
    // page heartbeat decides — see watchAlive.)
    if (Date.now() - started > 5000) { app.quit(); return; }
    // exited right away: either it handed the window to an already open browser (then the page sends heartbeats), or it
    // couldn't open — in that case the game opens in Electron's own window
    setTimeout(() => { if (!lastAlive && !mainWindow) void createWindow(port); }, 15000);
  });
}

/**
 * The game in the browser reports every 10 s that it is open; with no report for 45 s, the program quits —
 * even with the browser still open (its other windows don't keep the exe alive). Closing the game window
 * normally quits much sooner, through the "bye" message (/api/bye).
 */
function watchAlive() {
  setInterval(() => {
    if (!mainWindow && !current && lastAlive && Date.now() - lastAlive > 45_000) app.quit();
  }, 5000);
}

// ------------------------------------------------------------------------------------ data on disk
// The library and the settings live in files, next to the exe (or in the repository, in development):
//   config/settings.json   app settings (drum kit map, keys, colors, calibration, language…)
//   config/browser.log     which browser opened the game (diagnostics)
//   library/<song id>/     song.json (chart + library info) and the song files (source.gp, source.mid)
// The browser keeps a copy (IndexedDB/localStorage) to work fast; on every start the game compares both
// (frontend/src/app/platform/desktop-browser.ts). If the folders don't exist they are created when needed.
// If the exe's folder can't be written (e.g. inside Program Files), everything goes to %APPDATA%\OpenDrumHero
// (Linux: ~/.config/OpenDrumHero). The AppImage keeps them next to the .AppImage file, like the portable exe.

const SONG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
let dataRootCache = null;

function writableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

function dataRoot() {
  if (dataRootCache) return dataRootCache;
  const candidates = [
    process.env.OPENDRUMHERO_DATA_DIR,                                  // chosen by hand (tests, several setups)
    process.env.PORTABLE_EXECUTABLE_DIR,                                // portable exe: the folder of the .exe
    process.env.APPIMAGE && path.dirname(process.env.APPIMAGE),         // AppImage: the folder of the .AppImage
    app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..'),   // installed / repository
    app.getPath('userData'),
  ].filter(Boolean);
  dataRootCache = candidates.find(writableDir) || app.getPath('userData');
  return dataRootCache;
}
const configDir = () => path.join(dataRoot(), 'config');
const libraryDir = () => path.join(dataRoot(), 'library');
const settingsFile = () => path.join(configDir(), 'settings.json');

/** Writes a file without leaving it half written if the program closes in the middle. */
function writeFileSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { exists: true, values: data && typeof data.values === 'object' ? data.values : {} };
  } catch { return { exists: false, values: {} }; }
}

function saveSettings(body) {
  const values = {};
  for (const [k, v] of Object.entries(body?.values ?? {})) if (typeof v === 'string') values[k] = v;
  writeFileSafe(settingsFile(), JSON.stringify({ app: 'OpenDrumHero', version: 1, values }, null, 1));
}

/** Songs on disk: id and when each one last changed. */
function listLibrary() {
  let dirs = [];
  try { dirs = fs.readdirSync(libraryDir(), { withFileTypes: true }).filter(d => d.isDirectory() && SONG_ID.test(d.name)); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(libraryDir(), d.name, 'song.json'), 'utf8'));
      if (meta?.pkg?.id === d.name) out.push({ id: d.name, updatedAt: Number(meta.updatedAt) || 0 });
    } catch { /* not a song folder (or half copied): ignore */ }
  }
  return out;
}

/** A song from disk: library info + chart and its files in base64. */
function readLibrarySong(id) {
  const dir = path.join(libraryDir(), id);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'song.json'), 'utf8'));
    const files = {};
    for (const name of fs.readdirSync(dir)) {
      if (name === 'song.json' || !FILE_NAME.test(name) || name.endsWith('.tmp')) continue;
      files[name] = fs.readFileSync(path.join(dir, name)).toString('base64');
    }
    return { row: { id, pkg: meta.pkg, addedAt: meta.addedAt, isNew: !!meta.isNew, updatedAt: meta.updatedAt }, files };
  } catch { return null; }
}

/** Saves a song. Without `files`, only the library info/chart changes (the files on disk stay). */
function writeLibrarySong(id, body) {
  const row = body?.row;
  if (!row?.pkg || row.pkg.id !== id) throw new Error(tr('songNotFound'));
  const dir = path.join(libraryDir(), id);
  const meta = { pkg: row.pkg, addedAt: row.addedAt || Date.now(), isNew: !!row.isNew, updatedAt: row.updatedAt || Date.now() };
  if (body.files && typeof body.files === 'object') {
    // whole song: written in a new folder that then replaces the old one
    const tmp = `${dir}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const [name, b64] of Object.entries(body.files)) {
      if (FILE_NAME.test(name) && name !== 'song.json' && typeof b64 === 'string') fs.writeFileSync(path.join(tmp, name), Buffer.from(b64, 'base64'));
    }
    fs.writeFileSync(path.join(tmp, 'song.json'), JSON.stringify(meta));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } else {
    writeFileSafe(path.join(dir, 'song.json'), JSON.stringify(meta));
  }
}

function deleteLibrarySong(id) {
  fs.rmSync(path.join(libraryDir(), id), { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------ startup

let appPort = 0;
let gameBrowser = null;

async function start() {
  allowDevicePermissions(session.defaultSession);
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
  session.defaultSession.setUserAgent(cleanUserAgent(session.defaultSession.getUserAgent()));
  appPort = await serveApp();
  if (process.argv.includes('--electron-window')) { await createWindow(appPort); return; }
  // PC's default browser; if we can't tell which one, Windows opens the link in its own default
  gameBrowser = (await defaultBrowser()) ?? { name: 'default', path: null, chromium: false };
  openGame(appPort);
  watchAlive();
}

/** Opens the game in the default browser: own window if Chromium-based, otherwise a normal page. */
function openGame(port) {
  if (gameBrowser.chromium && gameBrowser.path) { openInBrowser(gameBrowser, port); return; }
  shell.openExternal(gameUrl(port)).catch(() => { if (!mainWindow) void createWindow(port); });
  // if the game page sends no heartbeat, the game opens in Electron's own window
  setTimeout(() => { if (!lastAlive && !mainWindow) void createWindow(port); }, 20000);
}

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); return; }
  if (gameBrowser) openGame(appPort);   // open the game window again
});
app.whenReady().then(start).catch(e => { console.error(e); app.quit(); });
// on quit: close the local server and the game window (nothing keeps running on the PC)
app.on('before-quit', () => {
  for (const s of [httpServer, httpServer6]) { try { s?.close(); s?.closeAllConnections?.(); } catch { /* already closed */ } }
  // (the browser belongs to the user: it isn't force-closed; the game window already closed)
  current?.cancel?.();
});
// the Songsterr login window can close without quitting the program (the game is in the browser)
// (if the game ended up in the Electron window — fallback —, closing it quits everything)
app.on('window-all-closed', () => { if (!gameBrowser || !lastAlive) app.quit(); });

// ------------------------------------------------------------------------------------- Songsterr
// "Windowless" import: a HIDDEN window opens the song with your Songsterr session, checks
// that you're logged in (and have Plus) and clicks download -> Guitar Pro; the app takes the file.
// A login window only appears if you're not logged in; after signing in it closes and the import continues
// hidden.

const GP_EXT = /\.(gp|gp3|gp4|gp5|gpx|gp7|gp8)$/i;
const MID_EXT = /\.(mid|midi)$/i;
const SIGNIN_URL = 'https://www.songsterr.com/signin';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 90 * 1000;
let current = null;   // import in progress

function autoScript() {
  return fs.readFileSync(path.join(APP_DIR, 'songsterr-auto.js'), 'utf8');
}

function songsterrSession() {
  const ses = session.fromPartition('persist:songsterr');
  // without "Electron" in the user agent: some logins refuse embedded browsers
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  return ses;
}

const webPrefs = { partition: 'persist:songsterr', contextIsolation: true, sandbox: true, backgroundThrottling: false };

async function run(win, code) {
  return win.webContents.executeJavaScript(`window.__drumheroLang=${JSON.stringify(lang)};\n${autoScript()}\n;${code}`, true);
}

async function loadAndCheck(win, url) {
  await win.loadURL(url);
  return run(win, '__drumheroAuto.check()');
}

/** Reads the login state straight from the site's HTML (the same state the page carries), without opening anything. */
async function isLoggedIn(ses) {
  try {
    const html = await (await ses.fetch('https://www.songsterr.com/', { cache: 'no-store' })).text();
    const m = html.match(/<script[^>]*id="state"[^>]*>([\s\S]*?)<\/script>/);
    return !!(m && JSON.parse(m[1])?.user?.isLoggedIn);
  } catch { return false; }
}

/** Login window (visible). Closes by itself when the login is detected. */
function askLogin(ses, send) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ width: 900, height: 820, title: tr('loginTitle'),
      autoHideMenuBar: true, parent: mainWindow || undefined, webPreferences: webPrefs });
    current.login = win;
    if (!mainWindow) { win.setAlwaysOnTop(true); win.focus(); }   // game in the browser: bring the window to the front
    let finished = false;
    const end = (ok, err) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      clearTimeout(limit);
      current.login = null;
      if (!win.isDestroyed()) win.close();
      ok ? resolve() : reject(err);
    };
    const timer = setInterval(async () => { if (await isLoggedIn(ses)) end(true); }, 2500);
    const limit = setTimeout(() => end(false, new Error(tr('loginTimeout'))), LOGIN_TIMEOUT_MS);
    win.on('closed', () => end(false, new Error(tr('loginClosed'))));
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions:
      { parent: win, autoHideMenuBar: true, webPreferences: webPrefs } }));
    send(tr('notLogged'));
    win.loadURL(SIGNIN_URL).catch(() => {});
  });
}

ipcMain.handle('songsterr:cancel', () => { current?.cancel?.(); });

ipcMain.handle('songsterr:fetch', (event, url, songLang) => {
  if (songLang) lang = songLang;
  return fetchSongsterr(url, msg => { if (!event.sender.isDestroyed()) event.sender.send('songsterr:progress', msg); });
});

async function fetchSongsterr(url, send) {
  if (current) throw new Error(tr('busy'));
  const ses = songsterrSession();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drumhero-'));
  let videoPointsUrl = null;
  let gotGp = null, gotMid = null;
  let onGp = null;

  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: webPrefs });
  current = { win, login: null, cancel: () => { current?.login?.close(); if (!win.isDestroyed()) win.close(); } };

  ses.webRequest.onCompleted({ urls: ['*://*.songsterr.com/*', '*://*.cloudfront.net/*'] }, d => {
    if (d.url.includes('/api/video-points/') && d.url.includes('/list')) videoPointsUrl = d.url;
  });
  const onDownload = (_e, item) => {
    const name = item.getFilename();
    const kind = GP_EXT.test(name) ? 'gp' : MID_EXT.test(name) ? 'mid' : null;
    if (!kind) { item.cancel(); return; }
    const dest = path.join(tmp, `${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`);
    item.setSavePath(dest);
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return;
      const data = new Uint8Array(fs.readFileSync(dest));
      if (kind === 'mid') { gotMid = data; return; }
      gotGp = { data, name };
      onGp?.();
    });
  };
  ses.on('will-download', onDownload);

  try {
    send(tr('opening'));
    let st = await loadAndCheck(win, url);
    if (!st.loggedIn) {
      await askLogin(ses, send);
      send(tr('loggedIn'));
      st = await loadAndCheck(win, url);
      if (!st.loggedIn) throw new Error(tr('notRecognized'));
    }
    if (!st.hasPlus) {
      throw new Error(tr('noPlus', { name: st.name ? ` (${st.name})` : '' }));
    }
    send(tr('downloading'));
    const arrived = new Promise((resolve, reject) => {
      onGp = resolve;
      setTimeout(() => reject(new Error(tr('timeout'))), DOWNLOAD_TIMEOUT_MS);
      win.on('closed', () => reject(new Error(tr('canceled'))));
    });
    arrived.catch(() => {});   // avoids an unhandled-rejection warning if something fails before the click
    await run(win, '__drumheroAuto.exportGp()');
    await arrived;
    send(tr('received'));
    // synced YouTube videos: the site only returns the list with the X-Sr-Token header (a song
    // code, from /api/meta/…); request it from inside the page itself, as the page does
    let videoPoints;
    try {
      const text = await win.webContents.executeJavaScript(`(async () => {
        let u = ${JSON.stringify(videoPointsUrl)};
        if (!u) {
          const m = /-s(\\d+)/.exec(location.pathname), st = document.getElementById('state');
          const rid = st && /"revisionId":([1-9]\\d*)/.exec(st.textContent);
          if (!m || !rid) return '';
          u = '/api/video-points/' + m[1] + '/' + rid[1] + '/list';
        }
        const o = { credentials: 'include', cache: 'no-store' };
        let t = await (await fetch(u, o)).text();
        if (t.trim().startsWith('[')) return t;
        const ids = /video-points\\/(\\d+)\\/(\\d+)/.exec(u);
        const meta = await (await fetch('/api/meta/' + ids[1] + '/' + ids[2], o)).json();
        if (!meta || !meta.image) return '';
        return await (await fetch(u, { ...o, headers: { 'X-Sr-Token': meta.image } })).text();
      })().catch(() => '')`, true);
      if (String(text).trim().startsWith('[')) videoPoints = JSON.parse(text);
    } catch { /* no videos */ }
    return { url, gp: gotGp.data, gpName: gotGp.name, mid: gotMid || undefined, videoPoints };
  } finally {
    ses.webRequest.onCompleted(null);
    ses.removeListener('will-download', onDownload);
    current?.login?.close();
    if (!win.isDestroyed()) win.close();
    current = null;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporary */ }
  }
}

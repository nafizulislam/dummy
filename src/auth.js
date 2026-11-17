// Password gate for the whole app. The password comes from the APP_PASSWORD environment
// variable (or "appPassword" in config/api.json for local use). Without one, the app stays locked.
// A sign-in is good for ONE page load: reloading or opening a page again asks for the password.
// The session itself stays valid for API calls and ticket files made from the already-open page.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'sv_auth';
const SESSION_MS = 12 * 3600 * 1000;
const MAX_TRIES = 10;
const WINDOW_MS = 15 * 60 * 1000;

function appPassword() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'api.json'), 'utf8')).appPassword || '';
  } catch (_) { return ''; }
}

const sessions = new Map(); // session id -> { exp, pagePass }

function newSession() {
  const now = Date.now();
  for (const [id, v] of sessions) if (v.exp < now) sessions.delete(id);
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { exp: now + SESSION_MS, pagePass: true });
  return sid;
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function cookieValue(req, name) {
  const hit = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

function sessionOf(req) {
  if (!appPassword()) return null;
  const sid = cookieValue(req, COOKIE);
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(sid); return null; }
  return s;
}

// Session cookie (no Max-Age): it also disappears when the browser is closed.
function setCookie(req, res, value, clear) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${clear ? '; Max-Age=0' : ''}${secure ? '; Secure' : ''}`);
}

const isPage = (req) => req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'));
const loginUrl = (req) => (req.path === '/' ? '/login' : `/login?next=${encodeURIComponent(req.path)}`);

const tries = new Map(); // ip -> { count, since }
function tooMany(ip) {
  const t = tries.get(ip);
  if (!t || Date.now() - t.since > WINDOW_MS) return false;
  return t.count >= MAX_TRIES;
}
function recordFail(ip) {
  const t = tries.get(ip);
  if (!t || Date.now() - t.since > WINDOW_MS) tries.set(ip, { count: 1, since: Date.now() });
  else t.count += 1;
}

function install(app) {
  const loginPage = path.join(__dirname, '..', 'public', 'login.html');

  app.get('/login', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(loginPage); });
  app.get('/login.html', (_req, res) => res.redirect('/login'));

  app.post('/login', (req, res) => {
    const pw = appPassword();
    if (!pw) return res.status(503).json({ error: 'No password is configured. Set APP_PASSWORD on the server and restart.' });
    const ip = req.ip || 'unknown';
    if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!safeEqual((req.body && req.body.password) || '', pw)) {
      recordFail(ip);
      return setTimeout(() => res.status(401).json({ error: 'Wrong password.' }), 600);
    }
    tries.delete(ip);
    setCookie(req, res, newSession(), false);
    return res.json({ ok: true });
  });

  app.get('/logout', (req, res) => {
    sessions.delete(cookieValue(req, COOKIE));
    setCookie(req, res, '', true);
    res.redirect('/login');
  });

  // Everything registered after this needs a valid session.
  app.use((req, res, next) => {
    const s = sessionOf(req);
    if (isPage(req)) {
      // Each sign-in opens a page once; a reload has no pass left and goes back to the password.
      if (!s || !s.pagePass) return res.redirect(loginUrl(req));
      s.pagePass = false;
      res.set('Cache-Control', 'no-store');
      return next();
    }
    if (s) return next();
    if (req.path.startsWith('/api/') || req.method !== 'GET') {
      return res.status(401).json({ error: 'Not signed in. Reload the page and enter the password.' });
    }
    return res.redirect('/login');
  });
}

module.exports = { install, appPassword };

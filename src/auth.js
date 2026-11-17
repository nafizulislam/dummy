// Password gate for the whole app. The password comes from the APP_PASSWORD environment
// variable (or "appPassword" in config/api.json for local use). Without one, the app stays locked.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'sv_auth';
const MAX_AGE_S = 7 * 24 * 3600;
const MAX_TRIES = 10;
const WINDOW_MS = 15 * 60 * 1000;

function appPassword() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'api.json'), 'utf8')).appPassword || '';
  } catch (_) { return ''; }
}

const sign = (pw) => crypto.createHmac('sha256', pw).update('sv-session-v1').digest('hex');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function cookieValue(req, name) {
  const hit = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

function isAuthed(req) {
  const pw = appPassword();
  return Boolean(pw) && safeEqual(cookieValue(req, COOKIE), sign(pw));
}

function setCookie(req, res, value, maxAge) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

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

  app.get('/login', (req, res) => (isAuthed(req) ? res.redirect('/') : res.sendFile(loginPage)));
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
    setCookie(req, res, sign(pw), MAX_AGE_S);
    return res.json({ ok: true });
  });

  app.get('/logout', (req, res) => {
    setCookie(req, res, '', 0);
    res.redirect('/login');
  });

  // Everything registered after this needs a valid session.
  app.use((req, res, next) => {
    if (isAuthed(req)) return next();
    if (req.path.startsWith('/api/') || req.method !== 'GET') {
      return res.status(401).json({ error: 'Not signed in. Reload the page and enter the password.' });
    }
    return res.redirect('/login');
  });
}

module.exports = { install, appPassword };

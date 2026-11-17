// Password gate for the whole app. The password comes from the APP_PASSWORD environment
// variable (or "appPassword" in config/api.json for local use). Without one, the app stays locked.
//
// Nothing is kept in server memory, so this works on serverless hosting (Vercel) where each
// request may run in a different instance. A sign-in sets two signed cookies:
//   sv_page - a pass for ONE page load, valid for a few seconds and cleared when the page is served,
//             so a reload (or opening a page again) asks for the password
//   sv_auth - lets the already-open page call the API for the next 12 hours
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_COOKIE = 'sv_auth';
const PAGE_COOKIE = 'sv_page';
const API_MS = 12 * 3600 * 1000;
const PAGE_MS = 20 * 1000;
const MAX_TRIES = 10;
const WINDOW_MS = 15 * 60 * 1000;

function appPassword() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'api.json'), 'utf8')).appPassword || '';
  } catch (_) { return ''; }
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Token = "<expiry ms>.<HMAC of kind + expiry>", keyed by the password: changing the password voids all tokens.
const mac = (pw, kind, exp) => crypto.createHmac('sha256', pw).update(`sv-v2.${kind}.${exp}`).digest('hex');
const makeToken = (pw, kind, ttl) => { const exp = Date.now() + ttl; return `${exp}.${mac(pw, kind, exp)}`; };

function validToken(token, kind) {
  const pw = appPassword();
  if (!pw || !token) return false;
  const [exp, sig] = String(token).split('.');
  if (!/^\d+$/.test(exp || '') || Number(exp) < Date.now()) return false;
  return safeEqual(sig || '', mac(pw, kind, exp));
}

function cookieValue(req, name) {
  const hit = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

// Session cookies (no Max-Age): they also disappear when the browser is closed.
function setCookie(req, res, name, value, clear) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${clear ? '; Max-Age=0' : ''}${secure ? '; Secure' : ''}`);
}

const isPage = (req) => req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'));
const loginUrl = (req) => (req.path === '/' ? '/login' : `/login?next=${encodeURIComponent(req.path)}`);

// Best-effort slowdown for guessing (per server instance).
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

function install(app, loginHtml) {
  app.get('/login', (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(loginHtml); });
  app.get('/login.html', (_req, res) => res.redirect('/login'));

  app.post('/login', (req, res) => {
    const pw = appPassword();
    if (!pw) return res.status(503).json({ error: 'No password is configured. Set APP_PASSWORD on the server and redeploy/restart.' });
    const ip = req.ip || 'unknown';
    if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!safeEqual((req.body && req.body.password) || '', pw)) {
      recordFail(ip);
      return setTimeout(() => res.status(401).json({ error: 'Wrong password.' }), 600);
    }
    tries.delete(ip);
    setCookie(req, res, API_COOKIE, makeToken(pw, 'api', API_MS), false);
    setCookie(req, res, PAGE_COOKIE, makeToken(pw, 'page', PAGE_MS), false);
    return res.json({ ok: true });
  });

  app.get('/logout', (req, res) => {
    setCookie(req, res, API_COOKIE, '', true);
    setCookie(req, res, PAGE_COOKIE, '', true);
    res.redirect('/login');
  });

  // Everything registered after this needs a valid sign-in.
  app.use((req, res, next) => {
    if (isPage(req)) {
      // The page pass is used up here; a reload has none and goes back to the password.
      if (!validToken(cookieValue(req, PAGE_COOKIE), 'page')) return res.redirect(loginUrl(req));
      setCookie(req, res, PAGE_COOKIE, '', true);
      res.set('Cache-Control', 'no-store');
      return next();
    }
    if (validToken(cookieValue(req, API_COOKIE), 'api')) return next();
    if (req.path.startsWith('/api/') || req.method !== 'GET') {
      return res.status(401).json({ error: 'Not signed in. Reload the page and enter the password.' });
    }
    return res.redirect('/login');
  });
}

module.exports = { install, appPassword };

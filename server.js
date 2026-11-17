// Express app. Runs as a normal server locally (npm start) and as a serverless function on Vercel,
// so it keeps nothing in memory or on disk between requests.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { generateTicket } = require('./src/pdf');
const { lookupFlight, searchRoute } = require('./src/lookup');
const { chat, Anthropic } = require('./src/agent');
const { AIRPORTS, AIRLINES, STATUSES } = require('./src/data');
const auth = require('./src/auth');
const SAMPLE = require('./samples/sample.json');

// Pages are loaded here and served through the password gate. They are deliberately NOT in public/:
// static hosting would hand them out without checking the password.
const PAGES = {
  index: fs.readFileSync(path.join(__dirname, 'pages', 'index.html'), 'utf8'),
  manual: fs.readFileSync(path.join(__dirname, 'pages', 'manual.html'), 'utf8'),
  login: fs.readFileSync(path.join(__dirname, 'pages', 'login.html'), 'utf8'),
};
const AGENCY = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'agency.json'), 'utf8'));

const app = express();
app.set('trust proxy', 1); // real client IP and https flag when running behind a hosting proxy
app.use(express.json({ limit: '4mb' }));
auth.install(app, PAGES.login); // password gate: everything below needs a valid sign-in

app.get('/', (_req, res) => res.type('html').send(PAGES.index));
app.get('/index.html', (_req, res) => res.type('html').send(PAGES.index));
app.get('/manual.html', (_req, res) => res.type('html').send(PAGES.manual));

app.get('/api/reference', (_req, res) => res.json({ airports: AIRPORTS, airlines: AIRLINES, statuses: STATUSES }));
app.get('/api/sample', (_req, res) => res.json(SAMPLE));
app.get('/api/agency', (_req, res) => res.json(AGENCY));

app.get('/api/lookup', async (req, res) => {
  try {
    res.json(await lookupFlight(req.query.flight, req.query.date));
  } catch (e) {
    if (e.user) return res.status(422).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const { from, to, airline, date } = req.query;
    res.json({ flights: await searchRoute(from, to, airline, date) });
  } catch (e) {
    if (e.user) return res.status(422).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---- AI agent ----
// The page sends the conversation so far with every message and gets the updated one back.
app.post('/api/agent', async (req, res) => {
  const { message } = req.body || {};
  const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (history.length > 200) return res.status(400).json({ error: 'This conversation is too long. Reload the page to start a new one.' });
  try {
    const out = await chat(history, String(message).slice(0, 4000));
    res.json({ ...out, history });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || /authentication|api key|credential/i.test(e.message || '')) {
      return res.status(401).json({ error: 'No valid Anthropic API key. Set ANTHROPIC_API_KEY on the server (or "anthropicKey" in config/api.json) and redeploy/restart.' });
    }
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Rate limited - try again in a moment.' });
    console.error(e);
    res.status(500).json({ error: 'Agent error: ' + (e.message || 'unknown') });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const pdf = await generateTicket(req.body);
    const pnr = String(req.body.pnr || 'ticket').replace(/[^A-Z0-9]/gi, '');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="itinerary-${pnr}.pdf"`,
      'Cache-Control': 'no-store',
    });
    res.send(pdf);
  } catch (e) {
    if (e.details) return res.status(400).json({ errors: e.details });
    console.error(e);
    res.status(500).json({ errors: ['Server error while generating PDF'] });
  }
});

// On Vercel the exported app is the function; locally we listen on a port.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Ticket generator running at http://localhost:${port}`);
    if (!auth.appPassword()) {
      console.warn('APP_PASSWORD is not set: the app stays locked until you set it (or "appPassword" in config/api.json) and restart.');
    }
  });
}

module.exports = app;

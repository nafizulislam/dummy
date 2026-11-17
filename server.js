const express = require('express');
const path = require('path');
const { generateTicket } = require('./src/pdf');
const { lookupFlight, searchRoute } = require('./src/lookup');
const { chat, Anthropic } = require('./src/agent');
const { AIRPORTS, AIRLINES, STATUSES } = require('./src/data');
const auth = require('./src/auth');

const app = express();
app.set('trust proxy', 1); // real client IP and https flag when running behind a hosting proxy
app.use(express.json({ limit: '1mb' }));
auth.install(app); // password gate: everything below needs a signed-in session
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/reference', (_req, res) => res.json({ airports: AIRPORTS, airlines: AIRLINES, statuses: STATUSES }));
app.get('/api/sample', (_req, res) => res.sendFile(path.join(__dirname, 'samples', 'sample.json')));
app.get('/api/agency', (_req, res) => res.sendFile(path.join(__dirname, 'config', 'agency.json')));

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
const sessions = new Map(); // sessionId -> messages (in-memory conversation)
app.use('/files', express.static(path.join(__dirname, 'output', 'tickets')));

app.post('/api/agent', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message are required' });
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  const history = sessions.get(sessionId);
  const snapshot = history.length;
  try {
    res.json(await chat(history, String(message).slice(0, 4000)));
  } catch (e) {
    history.length = snapshot; // drop the failed turn so the session stays valid
    if (e instanceof Anthropic.AuthenticationError || /authentication|api key|credential/i.test(e.message || '')) {
      return res.status(401).json({ error: 'No valid Anthropic API key. Put {"anthropicKey":"sk-ant-..."} in config/api.json (or set ANTHROPIC_API_KEY) and restart.' });
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
    });
    res.send(pdf);
  } catch (e) {
    if (e.details) return res.status(400).json({ errors: e.details });
    console.error(e);
    res.status(500).json({ errors: ['Server error while generating PDF'] });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Ticket generator running at http://localhost:${port}`);
  if (!auth.appPassword()) {
    console.warn('APP_PASSWORD is not set: the app stays locked until you set it (or "appPassword" in config/api.json) and restart.');
  }
});

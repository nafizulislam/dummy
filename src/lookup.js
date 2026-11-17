// Flight lookup via AviationStack (free plan ~100 req/month, so every result is cached on disk).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'data', 'flight-cache.json');

function apiKey() {
  if (process.env.AVIATIONSTACK_KEY) return process.env.AVIATIONSTACK_KEY;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'api.json'), 'utf8')).aviationstackKey || '';
  } catch (_) { return ''; }
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
  } catch (_) { /* read-only disk (serverless hosting): run without the cache */ }
}

// AviationStack returns LOCAL wall-clock time but labels it "+00:00" - so take the digits as-is.
const splitLocal = (iso) => (iso ? { date: iso.slice(0, 10), time: iso.slice(11, 16) } : {});

// Convert one AviationStack flight record into the segment shape used by the form/PDF.
function toSegment(rec) {
  const dep = rec.departure || {};
  const arr = rec.arrival || {};
  const d = splitLocal(dep.scheduled);
  const a = splitLocal(arr.scheduled);
  if (!dep.iata || !arr.iata || !d.date || !a.date) return null;
  const info = (x) => ({ name: x.airport || '', tz: x.timezone || '' });
  return {
    airline: (rec.airline && rec.airline.iata) || '',
    airlineName: (rec.airline && rec.airline.name) || '',
    flightNo: (rec.flight && rec.flight.iata) || '',
    aircraft: (rec.aircraft && (rec.aircraft.iata || rec.aircraft.icao)) || '',
    from: dep.iata, fromDate: d.date, fromTime: d.time, fromTerminal: dep.terminal || '', fromInfo: info(dep),
    to: arr.iata, toDate: a.date, toTime: a.time, toTerminal: arr.terminal || '', toInfo: info(arr),
  };
}

async function lookupFlight(flight, date) {
  const f = String(flight || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(f)) throw userError('Flight number should look like MU2036');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw userError('Date must be YYYY-MM-DD');

  const key = `${f}|${date}`;
  const cache = readCache();
  if (cache[key]) return { ...cache[key], cached: true };

  const token = apiKey();
  if (!token) {
    throw userError('No API key set. Get a free key at aviationstack.com, then put it in config/api.json as {"aviationstackKey":"..."} (or set AVIATIONSTACK_KEY).');
  }

  // Free plan is HTTP-only. The call is made server-side so the key never reaches the browser.
  const call = async (withDate) => {
    const url = `http://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(token)}&flight_iata=${f}${withDate ? `&flight_date=${date}` : ''}&limit=10`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      return await res.json();
    } catch (e) {
      throw userError('Could not reach the flight API (network/timeout). Enter the flight manually.');
    }
  };

  let body = await call(true);
  let approximate = false;
  // Free plans reject the date filter: fall back to the flight's latest known schedule.
  if (body.error && /restricted|not support/i.test(`${body.error.code} ${body.error.message}`)) {
    body = await call(false);
    approximate = true;
  }
  if (body.error) {
    throw userError(`Flight API: ${body.error.message || body.error.code || 'error'}. Enter the flight manually.`);
  }
  let seg = (body.data || []).map(toSegment).find(Boolean);
  if (!seg) throw userError(`No schedule found for ${f}. Enter it manually.`);

  if (approximate) seg = shiftToDate(seg, date);
  seg.approximate = approximate;

  cache[key] = seg;
  writeCache(cache);
  return { ...seg, cached: false };
}

// Re-anchor a known flight's departure to the requested date, keeping the same arrival-day offset.
function shiftToDate(seg, date) {
  const day = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  const offset = day(seg.toDate) - day(seg.fromDate);
  const iso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  return { ...seg, fromDate: date, toDate: iso(day(date) + offset) };
}

// Search flights on a route (e.g. DAC -> KMG), optionally for one airline. Cached for 24h.
async function searchRoute(from, to, airline, date) {
  const dep = String(from || '').toUpperCase();
  const arr = String(to || '').toUpperCase();
  const al = String(airline || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(dep) || !/^[A-Z]{3}$/.test(arr)) throw userError('Enter both airport codes (e.g. DAC and KMG) first');
  if (al && !/^[A-Z0-9]{2}$/.test(al)) throw userError('Airline code must be 2 characters, e.g. MU');

  const key = `route|${dep}|${arr}|${al}`;
  const cache = readCache();
  let list;
  if (cache[key] && Date.now() - cache[key].at < 24 * 3600 * 1000) {
    list = cache[key].list;
  } else {
    const token = apiKey();
    if (!token) throw userError('No API key set in config/api.json');
    const url = `http://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(token)}&dep_iata=${dep}&arr_iata=${arr}${al ? `&airline_iata=${al}` : ''}&limit=100`;
    let body;
    try {
      body = await (await fetch(url, { signal: AbortSignal.timeout(12000) })).json();
    } catch (_) {
      throw userError('Could not reach the flight API (network/timeout).');
    }
    if (body.error) throw userError(`Flight API: ${body.error.message || body.error.code}`);
    const seen = new Set();
    list = [];
    for (const rec of body.data || []) {
      if (rec.flight && rec.flight.codeshared) continue; // skip partner codeshare duplicates
      const seg = toSegment(rec);
      if (!seg) continue;
      const k = `${seg.flightNo}|${seg.fromTime}|${seg.toTime}`;
      if (seen.has(k)) continue;
      seen.add(k);
      list.push(seg);
    }
    list.sort((a, b) => a.fromTime.localeCompare(b.fromTime));
    cache[key] = { at: Date.now(), list };
    writeCache(cache);
  }
  const out = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? list.map((s) => shiftToDate(s, date)) : list;
  return out.map((s) => ({ ...s, approximate: true }));
}

function userError(message) {
  const e = new Error(message);
  e.user = true;
  return e;
}

module.exports = { lookupFlight, searchRoute, toSegment };

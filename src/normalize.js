// Validates the input JSON and enriches it with airport/airline details and computed durations.
const { AIRPORTS, AIRLINES, STATUSES } = require('./data');
const { localToUtc, fmtDate, fmtDayDate, fmtDateTime, fmtDuration, fmtLayover } = require('./time');

const fs = require('fs');
const path = require('path');

let AGENCY_DEFAULTS = {};
try {
  AGENCY_DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agency.json'), 'utf8'));
} catch (_) { /* no config: fall back to blanks */ }

// Default baggage per airline/cabin, used only when a passenger has none typed in.
let BAGGAGE = {};
try {
  BAGGAGE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'baggage.json'), 'utf8'));
} catch (_) { /* no config: baggage stays blank */ }

function defaultBaggage(airlineCode, cabin) {
  const key = /business|first/i.test(cabin || '') ? 'business' : 'economy';
  const pick = (row) => (row && (row[key] || row.economy)) || null;
  return pick(BAGGAGE[airlineCode]) || pick(BAGGAGE.default) || { checkin: '', cabin: '' };
}

// Common aircraft type codes -> display names (anything else is printed as given)
const AIRCRAFT = {
  B737: 'Boeing 737', B738: 'Boeing 738', B739: 'Boeing 739', B38M: 'Boeing 737 MAX 8',
  B744: 'Boeing 744', B772: 'Boeing 772', B77W: 'Boeing 77W', B773: 'Boeing 773', B788: 'Boeing 788', B789: 'Boeing 789', B78X: 'Boeing 78X',
  A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo',
  A332: 'Airbus A330-200', A333: 'Airbus A330-300', A359: 'Airbus A350-900', A35K: 'Airbus A350-1000', A388: 'Airbus A380-800',
  E190: 'Embraer E190', AT72: 'ATR 72',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function airport(code, override, errors, where) {
  const c = String(code || '').toUpperCase();
  const base = AIRPORTS[c] || {};
  const clean = Object.fromEntries(Object.entries(override || {}).filter(([, v]) => v));
  // Built-in data wins; supplied info only fills gaps (API names are often truncated/outdated).
  const a = { code: c, ...clean, ...base };
  if (!c) errors.push(`${where}: airport code missing`);
  else if (!a.city || !a.name || !a.tz) {
    errors.push(`${where}: unknown airport "${c}" - add its city, name and tz (IANA timezone) in the segment's ${where.endsWith('from') ? 'fromInfo' : 'toInfo'}`);
  }
  return a;
}

function normalize(input) {
  const errors = [];
  const d = input || {};

  const given = Object.fromEntries(Object.entries(d.agency || {}).filter(([, v]) => v));
  const agency = {
    brand: '', name: '', address: '', licenseLabel: 'License No', licenseNo: '', emergencyContact: '',
    ...AGENCY_DEFAULTS,
    ...given,
  };
  if (!agency.brand) agency.brand = agency.name;

  if (!d.pnr) errors.push('pnr is required');
  const status = String(d.status || 'RESERVED').toUpperCase();
  if (!STATUSES.includes(status)) errors.push(`status must be one of: ${STATUSES.join(', ')}`);
  const pax = Array.isArray(d.passengers) ? d.passengers : [];
  if (!pax.length) errors.push('at least one passenger is required');
  pax.forEach((p, i) => {
    if (!p.name) errors.push(`passenger ${i + 1}: name is required`);
  });

  const journeysIn = Array.isArray(d.journeys) ? d.journeys : [];
  if (!journeysIn.length) errors.push('at least one journey is required');

  const journeys = journeysIn.map((j, ji) => {
    const segsIn = Array.isArray(j.segments) ? j.segments : [];
    if (!segsIn.length) errors.push(`journey ${ji + 1}: needs at least one segment`);

    let prevArrUtc = null;
    let prevCity = null;
    let prevCode = null;
    const segments = segsIn.map((s, si) => {
      const w = `journey ${ji + 1} segment ${si + 1}`;
      const from = airport(s.from, s.fromInfo, errors, `${w} from`);
      const to = airport(s.to, s.toInfo, errors, `${w} to`);
      ['fromDate', 'toDate'].forEach((k) => { if (!DATE_RE.test(s[k] || '')) errors.push(`${w}: ${k} must be YYYY-MM-DD`); });
      ['fromTime', 'toTime'].forEach((k) => { if (!TIME_RE.test(s[k] || '')) errors.push(`${w}: ${k} must be HH:MM`); });

      const code = String(s.airline || '').toUpperCase();
      const al = AIRLINES[code] || {};
      const airlineName = s.airlineName || al.name || code;
      if (!code) errors.push(`${w}: airline code missing`);

      let durationMins = null;
      let layoverMins = null;
      if (!errors.length) {
        const dep = localToUtc(s.fromDate, s.fromTime, from.tz);
        const arr = localToUtc(s.toDate, s.toTime, to.tz);
        durationMins = Math.round((arr - dep) / 60000);
        if (durationMins <= 0) errors.push(`${w}: arrival is not after departure (check dates/times)`);
        if (prevArrUtc !== null) {
          layoverMins = Math.round((dep - prevArrUtc) / 60000);
          if (layoverMins < 0) errors.push(`${w}: departs before the previous segment arrives`);
        }
        prevArrUtc = arr;
      }
      const seg = {
        airlineCode: code, airlineName, logoColor: s.logoColor || al.color || '#444a8c',
        flightNo: String(s.flightNo || ''), aircraft: AIRCRAFT[String(s.aircraft || '').toUpperCase()] || s.aircraft || '',
        from, to,
        depText: errors.length ? '' : fmtDateTime(s.fromDate, s.fromTime),
        arrText: errors.length ? '' : fmtDateTime(s.toDate, s.toTime),
        depTime: s.fromTime || '', arrTime: s.toTime || '',
        depDate: errors.length ? '' : fmtDayDate(s.fromDate),
        arrDate: errors.length ? '' : fmtDayDate(s.toDate),
        fromTerminal: s.fromTerminal || '', toTerminal: s.toTerminal || '',
        durationText: durationMins > 0 ? fmtDuration(durationMins) : '',
        layoverBefore: layoverMins !== null
          ? { text: fmtLayover(layoverMins), duration: fmtDuration(layoverMins), city: prevCity, code: prevCode }
          : null,
      };
      prevCity = to.city;
      prevCode = to.code;
      return seg;
    });

    const first = segments[0];
    const last = segments[segments.length - 1];
    const stops = Math.max(segments.length - 1, 0);
    return {
      cabin: j.cabin || 'Economy Class',
      fromCode: first && first.from.code, toCode: last && last.to.code,
      dateText: first && segsIn[0].fromDate ? fmtDate(segsIn[0].fromDate) : '',
      stopsText: stops === 0 ? 'Non-stop' : `${stops} Stop${stops > 1 ? 's' : ''}`,
      segments,
    };
  });

  if (errors.length) {
    const e = new Error('Invalid ticket data');
    e.details = errors;
    throw e;
  }

  const firstSeg = journeys[0] && journeys[0].segments[0];
  const bag = defaultBaggage(firstSeg && firstSeg.airlineCode, journeys[0] && journeys[0].cabin);

  const now = new Date();
  const created = d.createdAt || `${fmtDate(now.toISOString().slice(0, 10))} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  return {
    agency,
    pnr: String(d.pnr).toUpperCase(),
    bookingId: d.bookingId || `${d.bookingIdPrefix || 'BK'}${Date.now().toString().slice(-8)}`,
    status,
    createdAt: created,
    payBy: d.payBy ? `${fmtDate(String(d.payBy).slice(0, 10))} ${String(d.payBy).slice(11, 16)} UTC` : '',
    watermark: '',
    passengers: pax.map((p) => ({
      title: (p.title || '').toUpperCase(),
      name: String(p.name).toUpperCase(),
      type: (p.type || 'ADULT').toUpperCase(),
      passport: p.passport || '',
      checkin: p.checkin || bag.checkin || '',
      cabin: p.cabin || bag.cabin || '',
    })),
    journeys,
  };
}

module.exports = { normalize };

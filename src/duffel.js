// Duffel integration: search real offers, create a HOLD order (no payment), read back the airline PNR.
// Docs: https://duffel.com/docs/guides/holding-orders-and-paying-later
const fs = require('fs');
const path = require('path');
const { fmtDate } = require('./time');

const BASE = 'https://api.duffel.com';

function token() {
  if (process.env.DUFFEL_TOKEN) return process.env.DUFFEL_TOKEN;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'api.json'), 'utf8')).duffelToken || '';
  } catch (_) { return ''; }
}

const isTestToken = () => token().startsWith('duffel_test_');

function userError(message) {
  const e = new Error(message);
  e.user = true;
  return e;
}

async function api(method, route, body) {
  const t = token();
  if (!t) throw userError('No Duffel token. Add "duffelToken" to config/api.json (or set DUFFEL_TOKEN).');
  let res;
  try {
    res = await fetch(BASE + route, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        'Duffel-Version': 'v2',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify({ data: body }) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch (_) {
    throw userError('Could not reach Duffel (network/timeout).');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errs = (json.errors || []).map((x) => x.message || x.title).filter(Boolean);
    throw userError(`Duffel: ${errs.join('; ') || `HTTP ${res.status}`}`);
  }
  return json.data;
}

const localParts = (iso) => ({ date: String(iso).slice(0, 10), time: String(iso).slice(11, 16) });

// Compact view of one offer for the agent
function summarizeOffer(o) {
  return {
    offer_id: o.id,
    airline: o.owner && o.owner.name,
    total: `${o.total_amount} ${o.total_currency}`,
    expires_at: o.expires_at,
    pay_later_until: o.payment_requirements && o.payment_requirements.payment_required_by,
    price_guaranteed: !!(o.payment_requirements && o.payment_requirements.price_guarantee_expires_at),
    slices: (o.slices || []).map((s) => ({
      from: s.origin.iata_code, to: s.destination.iata_code,
      segments: (s.segments || []).map((g) => ({
        flight: `${g.marketing_carrier.iata_code}${g.marketing_carrier_flight_number}`,
        from: g.origin.iata_code, dep: String(g.departing_at).slice(0, 16),
        to: g.destination.iata_code, arr: String(g.arriving_at).slice(0, 16),
      })),
    })),
  };
}

// slices: [{from,to,date}], adults: number, cabin: economy|premium_economy|business|first
async function searchOffers({ slices, adults = 1, cabin = 'economy', maxResults = 8 }) {
  if (!Array.isArray(slices) || !slices.length) throw userError('At least one slice (from, to, date) is required');
  const data = await api('POST', '/air/offer_requests?return_offers=true&supplier_timeout=20000', {
    slices: slices.map((s) => ({
      origin: String(s.from).toUpperCase(), destination: String(s.to).toUpperCase(), departure_date: s.date,
    })),
    passengers: Array.from({ length: Math.max(1, adults) }, () => ({ type: 'adult' })),
    cabin_class: cabin,
  });
  const offers = (data.offers || [])
    // Only offers that can be held without instant payment
    .filter((o) => o.payment_requirements && o.payment_requirements.requires_instant_payment === false)
    .sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))
    .slice(0, maxResults);
  return {
    mode: isTestToken() ? 'TEST (sandbox - PNRs are not real)' : 'LIVE',
    total_offers: (data.offers || []).length,
    holdable_offers: offers.map(summarizeOffer),
  };
}

// passengers: [{title, given_name, family_name, gender:'m'|'f', born_on, email, phone_number, passport?}]
async function createHold(offerId, passengers) {
  const offer = await api('GET', `/air/offers/${encodeURIComponent(offerId)}`);
  if (!offer.payment_requirements || offer.payment_requirements.requires_instant_payment !== false) {
    throw userError('This offer cannot be held (instant payment required). Pick another offer.');
  }
  const slots = offer.passengers || [];
  if (passengers.length !== slots.length) {
    throw userError(`This offer is for ${slots.length} passenger(s) but ${passengers.length} were supplied.`);
  }
  const paxPayload = passengers.map((p, i) => {
    const miss = ['title', 'given_name', 'family_name', 'gender', 'born_on', 'email', 'phone_number'].filter((k) => !p[k]);
    if (miss.length) throw userError(`Passenger ${i + 1} is missing: ${miss.join(', ')}`);
    const out = {
      id: slots[i].id,
      title: String(p.title).toLowerCase(),
      gender: String(p.gender).toLowerCase(),
      given_name: p.given_name, family_name: p.family_name,
      born_on: p.born_on, email: p.email, phone_number: p.phone_number,
    };
    if (p.passport && p.passport.number && p.passport.issuing_country && p.passport.expires_on) {
      out.identity_documents = [{
        type: 'passport', unique_identifier: p.passport.number,
        issuing_country_code: p.passport.issuing_country, expires_on: p.passport.expires_on,
      }];
    }
    return out;
  });
  const order = await api('POST', '/air/orders', { type: 'hold', selected_offers: [offerId], passengers: paxPayload });
  return order;
}

// Convert a Duffel order into the booking JSON used by the PDF generator.
function bookingFromOrder(order, extras = {}) {
  const cabinOf = (seg) => {
    const p = seg.passengers && seg.passengers[0];
    return (p && p.cabin_class_marketing_name) || '';
  };
  const bagText = (o) => {
    const bags = (o.slices && o.slices[0] && o.slices[0].segments[0] && o.slices[0].segments[0].passengers[0].baggages) || [];
    const checked = bags.find((b) => b.type === 'checked');
    const carry = bags.find((b) => b.type === 'carry_on');
    return {
      checkin: checked ? `${checked.quantity} PC` : '',
      cabin: carry ? `${carry.quantity} PC` : '',
    };
  };
  const bags = bagText(order);
  const passport = (i) => extras.passports && extras.passports[i];

  return {
    pnr: order.booking_reference,
    status: 'ON HOLD',
    payBy: order.payment_status && order.payment_status.payment_required_by,
    createdAt: undefined,
    passengers: (order.passengers || []).map((p, i) => ({
      title: (p.title || '').toUpperCase(),
      name: `${p.given_name} ${p.family_name}`,
      type: String(p.type || 'adult').toUpperCase(),
      passport: passport(i) || (p.identity_documents && p.identity_documents[0] && p.identity_documents[0].unique_identifier) || '',
      checkin: bags.checkin, cabin: bags.cabin,
    })),
    journeys: (order.slices || []).map((s) => ({
      cabin: cabinOf(s.segments[0]) || 'Economy Class',
      segments: s.segments.map((g) => {
        const d = localParts(g.departing_at);
        const a = localParts(g.arriving_at);
        return {
          airline: g.marketing_carrier.iata_code,
          airlineName: g.marketing_carrier.name,
          flightNo: `${g.marketing_carrier.iata_code}${g.marketing_carrier_flight_number}`,
          aircraft: (g.aircraft && g.aircraft.name) || '',
          from: g.origin.iata_code, fromDate: d.date, fromTime: d.time, fromTerminal: g.origin_terminal || '',
          fromInfo: { city: g.origin.city_name, name: g.origin.name, tz: g.origin.time_zone },
          to: g.destination.iata_code, toDate: a.date, toTime: a.time, toTerminal: g.destination_terminal || '',
          toInfo: { city: g.destination.city_name, name: g.destination.name, tz: g.destination.time_zone },
        };
      }),
    })),
  };
}

module.exports = { searchOffers, createHold, bookingFromOrder, isTestToken, fmtDate };

// AI booking agent: takes a plain-language request, searches routes/flights with tools,
// then builds the itinerary PDF. Uses the Claude API with a manual tool loop.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { lookupFlight, searchRoute } = require('./lookup');
const { generateTicket } = require('./pdf');
const { normalize } = require('./normalize');
const { STATUSES } = require('./data');
const duffel = require('./duffel');

const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 14;
const OUT_DIR = path.join(__dirname, '..', 'output', 'tickets');

function anthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'api.json'), 'utf8')).anthropicKey || '';
  } catch (_) { return ''; }
}

let client = null;
function getClient() {
  if (!client) {
    const apiKey = anthropicKey();
    client = apiKey ? new Anthropic({ apiKey }) : new Anthropic(); // falls back to env/profile credentials
  }
  return client;
}

const SYSTEM = `You are the booking assistant for HR Trade and Tourism's itinerary generator. Staff describe a trip in plain language; you find the flights with your tools and produce the itinerary PDF.

Workflow:
1. Work out the journeys (outbound, return, connections). Each connection is its own segment: search each leg (e.g. DAC-KMG, then KMG-HKG).
2. Use search_route / lookup_flight to get real flight data. Pick flights that match what the user asked (airline, times, sensible layovers). If several fit and the user did not say, choose the most sensible one and say which you chose.
3. Call build_ticket with the passenger(s), the airline PNR and the segments exactly as the flight tools returned them (keep airline, flightNo, aircraft, airport codes, local dates/times, terminals, fromInfo/toInfo).
4. Reply with a short summary: route, flights, times, layovers, and anything the user must verify.

Pasted itineraries (the usual case):
- Staff often paste a route block copied from a booking system (flight numbers, 12-hour times, dates like "1 Mar, Monday", aircraft, class such as "ECONOMY-3 (Q)", layovers) plus the passenger name, passport and the PNR from their GDS.
- Use the pasted flight numbers, dates, times and aircraft EXACTLY as given. Do not replace them with tool results. Convert times to 24-hour HH:MM. If the year is missing, pick the next year in which that date falls on the stated weekday.
- Do not call search_route or lookup_flight when the paste already has flight number, airports, date and times for every segment. Go straight to build_ticket. Use the tools only to fill genuine gaps.
- For an airport build_ticket reports as unknown, supply fromInfo/toInfo yourself: { city, name, tz } with the IANA timezone.
- Cabin: map "ECONOMY-3 (Q)" and similar to "Economy Class" (Business -> "Business Class").
- Baggage is optional: if not given, leave checkin/cabin empty. build_ticket fills the agency default for that airline and returns it; state the values it used in one line so staff can check them against the fare. Do not ask for it.
- If the PNR is missing, ask for it in one short sentence and nothing else.

Getting a real PNR (only when the user has no PNR and wants one):
- Use search_offers to find real bookable offers that can be HELD without payment (it only returns holdable ones).
- Show the user the best 2-3 options (airline, flights, times, price, pay-later deadline) and wait for them to pick one.
- create_hold sends the passenger's personal data to Duffel and creates a real reservation. Before calling it, you must have ALL of: title, given name, family name, gender (m/f), date of birth, email, phone in international format (+880...) for every passenger, and the user's explicit "yes" to that exact offer and those exact details in this conversation. Then set customer_confirmed=true. Never invent or guess any of these details; ask for what is missing.
- search_offers/create_hold report a mode. In TEST mode the PNR is a sandbox code, not a real booking - say so plainly. In LIVE mode a hold expires at the pay-later deadline unless the airline is paid; tell the user the deadline.
- create_hold already builds the PDF; do not call build_ticket afterwards for the same booking.

Hard rules:
- Never invent a PNR, passenger name, passport number, or baggage allowance. If the PNR, name or passport is missing, ask the user before calling build_ticket. The PNR must be the real airline reservation code the user gives you.
- Status must be one of: ${STATUSES.join(', ')}. Always use RESERVED unless the user explicitly names another status. Never present a booking as paid or ticketed.
- The flight data comes from a free API that lacks future-dated schedules: times for future dates are the flight's latest known schedule, not guaranteed. Always tell the user to verify times against the PNR.
- If a search returns nothing, say so and ask the user for the flight details rather than guessing.
- If build_ticket returns errors, fix what you can from the data you already have; ask the user only for what is genuinely missing.
- Be concise.`;

const segmentSchema = {
  type: 'object',
  properties: {
    airline: { type: 'string', description: '2-letter IATA airline code, e.g. MU' },
    flightNo: { type: 'string', description: 'e.g. MU2036' },
    aircraft: { type: 'string' },
    from: { type: 'string', description: 'IATA airport code' },
    fromDate: { type: 'string', description: 'YYYY-MM-DD local' },
    fromTime: { type: 'string', description: 'HH:MM local' },
    fromTerminal: { type: 'string' },
    fromInfo: { type: 'object', description: 'Pass through from the flight tools if present' },
    to: { type: 'string' },
    toDate: { type: 'string' },
    toTime: { type: 'string' },
    toTerminal: { type: 'string' },
    toInfo: { type: 'object' },
  },
  required: ['airline', 'flightNo', 'from', 'fromDate', 'fromTime', 'to', 'toDate', 'toTime'],
};

const TOOLS = [
  {
    name: 'search_route',
    description: 'List flights operating on a route (e.g. DAC to KMG). Optionally filter by airline. Pass the desired departure date so results are dated for it. Returns flight number, local dep/arr times and aircraft.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Departure IATA code' },
        to: { type: 'string', description: 'Arrival IATA code' },
        airline: { type: 'string', description: 'Optional 2-letter airline code' },
        date: { type: 'string', description: 'Desired departure date YYYY-MM-DD' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'lookup_flight',
    description: 'Get one flight\'s route and times by flight number and departure date.',
    input_schema: {
      type: 'object',
      properties: {
        flight: { type: 'string', description: 'e.g. MU2036' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['flight', 'date'],
    },
  },
  {
    name: 'search_offers',
    description: 'Search real flight offers via Duffel and return only those that can be held without payment. Use when the user needs a new real PNR. Returns offer_id, airline, price, flights and the pay-later deadline.',
    input_schema: {
      type: 'object',
      properties: {
        slices: {
          type: 'array',
          description: 'One per direction: outbound, plus return if needed',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'IATA code' },
              to: { type: 'string', description: 'IATA code' },
              date: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['from', 'to', 'date'],
          },
        },
        adults: { type: 'integer', description: 'Number of adult passengers (default 1)' },
        cabin: { type: 'string', enum: ['economy', 'premium_economy', 'business', 'first'] },
      },
      required: ['slices'],
    },
  },
  {
    name: 'create_hold',
    description: 'Create a pay-later HOLD reservation for a chosen offer and generate the itinerary PDF. Sends passenger personal data to Duffel. Only call after the user has explicitly confirmed this exact offer and passenger details.',
    input_schema: {
      type: 'object',
      properties: {
        offer_id: { type: 'string' },
        customer_confirmed: { type: 'boolean', description: 'true only if the user explicitly said yes to this offer and these details' },
        passengers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'mr, mrs, ms, miss, dr' },
              given_name: { type: 'string' },
              family_name: { type: 'string' },
              gender: { type: 'string', enum: ['m', 'f'] },
              born_on: { type: 'string', description: 'YYYY-MM-DD' },
              email: { type: 'string' },
              phone_number: { type: 'string', description: 'E.164, e.g. +8801712345678' },
              passport: {
                type: 'object',
                description: 'Optional, include only if the user supplied all three',
                properties: { number: { type: 'string' }, issuing_country: { type: 'string', description: '2-letter ISO' }, expires_on: { type: 'string' } },
              },
            },
            required: ['title', 'given_name', 'family_name', 'gender', 'born_on', 'email', 'phone_number'],
          },
        },
      },
      required: ['offer_id', 'passengers', 'customer_confirmed'],
    },
  },
  {
    name: 'build_ticket',
    description: 'Validate the booking and generate the itinerary PDF. Call only when you have a real PNR, passenger details and all segments.',
    input_schema: {
      type: 'object',
      properties: {
        pnr: { type: 'string', description: 'Real airline PNR supplied by the user' },
        status: { type: 'string', enum: STATUSES },
        passengers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'MR, MRS, MS, MSTR, MISS' },
              name: { type: 'string', description: 'Full name as on passport' },
              type: { type: 'string', enum: ['ADULT', 'CHILD', 'INFANT'] },
              passport: { type: 'string' },
              checkin: { type: 'string', description: 'e.g. 30KG' },
              cabin: { type: 'string', description: 'e.g. 7Kg' },
            },
            required: ['name'],
          },
        },
        journeys: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              cabin: { type: 'string', description: 'default Economy Class' },
              segments: { type: 'array', items: segmentSchema },
            },
            required: ['segments'],
          },
        },
      },
      required: ['pnr', 'passengers', 'journeys'],
    },
  },
];

const brief = (s) => ({
  flightNo: s.flightNo, airline: s.airline, aircraft: s.aircraft,
  from: s.from, fromDate: s.fromDate, fromTime: s.fromTime, fromTerminal: s.fromTerminal, fromInfo: s.fromInfo,
  to: s.to, toDate: s.toDate, toTime: s.toTime, toTerminal: s.toTerminal, toInfo: s.toInfo,
});

async function runTool(name, input) {
  try {
    if (name === 'search_route') {
      const flights = await searchRoute(input.from, input.to, input.airline, input.date);
      return { flights: flights.slice(0, 12).map(brief), note: flights.length ? 'Times are the latest known schedule re-dated to the request.' : 'No flights found.' };
    }
    if (name === 'lookup_flight') {
      return brief(await lookupFlight(input.flight, input.date));
    }
    if (name === 'search_offers') {
      return await duffel.searchOffers({ slices: input.slices, adults: input.adults || 1, cabin: input.cabin || 'economy' });
    }
    if (name === 'create_hold') {
      if (input.customer_confirmed !== true) return { error: 'Not confirmed. Ask the user to confirm the offer and passenger details first.' };
      const order = await duffel.createHold(input.offer_id, input.passengers);
      const passports = (input.passengers || []).map((p) => p.passport && p.passport.number);
      const booking = duffel.bookingFromOrder(order, { passports });
      const pdf = await generateTicket(booking);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const file = `${String(booking.pnr).replace(/[^A-Z0-9]/gi, '')}-${Date.now()}.pdf`;
      fs.writeFileSync(path.join(OUT_DIR, file), pdf);
      return {
        ok: true, mode: duffel.isTestToken() ? 'TEST (sandbox - PNR is not a real booking)' : 'LIVE',
        pnr: booking.pnr, pay_by: booking.payBy, total: `${order.total_amount} ${order.total_currency}`,
        file, url: `/files/${file}`,
      };
    }
    if (name === 'build_ticket') {
      normalize(input); // validate first for clear errors
      const pdf = await generateTicket(input);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const file = `${String(input.pnr).replace(/[^A-Z0-9]/gi, '')}-${Date.now()}.pdf`;
      fs.writeFileSync(path.join(OUT_DIR, file), pdf);
      const used = normalize(input).passengers.map((p) => ({ name: p.name, checkin: p.checkin, cabin: p.cabin }));
      return { ok: true, file, url: `/files/${file}`, baggage: used };
    }
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: e.details ? e.details.join('; ') : e.message };
  }
}

// One agent turn: runs the tool loop until Claude replies in text. `messages` is mutated (conversation memory).
async function chat(messages, userText) {
  messages.push({ role: 'user', content: userText });
  const steps = [];
  let ticketUrl = null;

  for (let i = 0; i < MAX_STEPS; i++) {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return { reply: 'The assistant declined this request.', steps, ticketUrl };
    }
    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason !== 'tool_use') {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: text || '(no reply)', steps, ticketUrl };
    }

    const results = [];
    for (const block of response.content.filter((b) => b.type === 'tool_use')) {
      const out = await runTool(block.name, block.input);
      steps.push(block.name + (out.error ? ' (error)' : ''));
      if (out.url) ticketUrl = out.url;
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'Stopped after too many steps - please narrow the request.', steps, ticketUrl };
}

module.exports = { chat, TOOLS, runTool, Anthropic };

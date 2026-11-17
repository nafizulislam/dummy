# Dummy Ticket Generator

Generates an A4 flight-itinerary PDF (agency header, passenger table, PNR, routes, layovers, reminders)
from route + customer + PNR data. Flight durations and layovers are computed from real airport timezones.

## Run
    npm install
    npm start                      # http://localhost:3000
    node cli.js samples/sample.json output/ticket.pdf

## Access
The AI booking agent is the home page (/); the manual form is at /manual.html.
Every page and API call needs the password from the APP_PASSWORD environment variable
(or "appPassword" in config/api.json for local use). Without it the app stays locked.
Other secrets: ANTHROPIC_API_KEY, AVIATIONSTACK_KEY, DUFFEL_TOKEN.

## API
POST /api/generate  (JSON like samples/sample.json) -> application/pdf

## Notes
- Put YOUR company details in `agency` (brand, name, address, license, emergency contact).
- Add airports/airlines in src/data.js, or supply `fromInfo` / `toInfo` per segment.
- `status` defaults to "RESERVED". Baggage left blank is filled from config/baggage.json (per airline and cabin).

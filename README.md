# Dummy Ticket Generator

Generates an A4 flight-itinerary PDF (agency header, passenger table, PNR, routes, layovers, reminders)
from route + customer + PNR data. Flight durations and layovers are computed from real airport timezones.

## Run
    npm install
    npm start                      # web form at http://localhost:3000
    node cli.js samples/sample.json output/ticket.pdf

## API
POST /api/generate  (JSON like samples/sample.json) -> application/pdf

## Notes
- Put YOUR company details in `agency` (brand, name, address, license, emergency contact).
- Add airports/airlines in src/data.js, or supply `fromInfo` / `toInfo` per segment.
- `status` defaults to "RESERVED". Baggage left blank is filled from config/baggage.json (per airline and cabin).

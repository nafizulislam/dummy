// Renders the normalized booking into an A4 PDF: agency header, reference box,
// traveler table, per-journey flight tables with layover rows, and reminders.
const PDFDocument = require('pdfkit');

// pdfkit loads its standard-font data lazily through a dynamic require, which serverless hosting
// (Vercel) cannot see when it decides which files to ship - the PDF then fails with a missing
// font file. Requiring the fonts we use here makes them part of the deployment.
require('pdfkit/standard-fonts/Helvetica');
require('pdfkit/standard-fonts/HelveticaBold');
require('pdfkit/standard-fonts/HelveticaOblique');
const { normalize } = require('./normalize');

const W = 595.28;
const H = 841.89;
const M = 52;
const CW = W - M * 2;
const BOTTOM = H - 55;
const TOP = 48;

const C = {
  navy: '#12355b', ink: '#1a1a1a', body: '#333333', muted: '#6b6b6b', faint: '#8a8a8a',
  rule: '#d4d8de', headBg: '#f2f4f7', boxBg: '#f3f6f9', boxBorder: '#d7dde5',
  orange: '#e57b22', red: '#c0392b', green: '#2e8b57',
};

const STATUS_COLOR = { CANCELLED: C.red, CONFIRMED: C.green, TICKETED: C.green };

const REMINDERS = [
  ['Passport and visa:', 'The passenger is responsible for holding a valid passport and all visas or entry permits required for the destination and any transit points. The airline may refuse boarding if documents are incomplete.'],
  ['Name:', 'The passenger’s name must match the passport exactly. Name changes are not permitted after ticketing, and corrections may carry a fee.'],
  ['Reconfirmation:', 'Flight times may change. Passengers should reconfirm the schedule with the airline or agency 24 to 72 hours before departure.'],
  ['Transit:', 'For connecting flights, passengers must check transit visa requirements and allow for the minimum connection time at the transit airport.'],
];

// Flight table columns: [x, width]
const COL = {
  flight: [M + 10, 92],
  dep: [M + 104, 116],
  arr: [M + 228, 116],
  cls: [M + 352, 66],
  dur: [M + 420, CW - 430],
};

function t(doc, str, x, y, opts = {}) {
  doc.text(str, x, y, { lineBreak: false, ...opts });
}

function hline(doc, x1, x2, y, color = C.rule, width = 0.7) {
  doc.save().strokeColor(color).lineWidth(width).moveTo(x1, y).lineTo(x2, y).stroke().restore();
}

// A cell is a list of lines: { text, font, size, color }. Lines wrap within the column width.
function cellHeight(doc, lines, w) {
  return lines.reduce((h, l) => {
    doc.font(l.font).fontSize(l.size);
    return h + doc.heightOfString(l.text, { width: w, lineGap: 0.5 });
  }, 0);
}

function drawCell(doc, lines, x, y, w, align = 'left') {
  lines.forEach((l) => {
    doc.fillColor(l.color).font(l.font).fontSize(l.size);
    doc.text(l.text, x, y, { width: w, align, lineGap: 0.5 });
    y = doc.y;
  });
}

function sectionTitle(doc, title, y) {
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(10.5);
  t(doc, title, M, y);
  hline(doc, M, W - M, y + 16, C.rule, 0.8);
  return y + 26;
}

function header(doc, d) {
  const a = d.agency;
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(23);
  t(doc, a.brand || a.name || '', M, 36);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8.5);
  t(doc, 'FLIGHT ITINERARY', M, 62, { characterSpacing: 0.6 });

  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11);
  t(doc, 'Ticket Reservation', W - M - 200, 35, { width: 200, align: 'right' });
  const date = String(d.createdAt || '').replace(/\s+\d{1,2}:\d{2}.*$/, '');
  if (date) {
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5);
    t(doc, `Date: ${date}`, W - M - 200, 51, { width: 200, align: 'right' });
  }
  if (a.licenseNo) {
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5);
    t(doc, `${a.licenseLabel || 'License No'}: ${a.licenseNo}`, W - M - 200, 63, { width: 200, align: 'right' });
  }
  hline(doc, M, W - M, 82, C.navy, 2.2);
}

function referenceBox(doc, d, y) {
  const h = 46;
  doc.save().rect(M, y, CW, h).fill(C.boxBg).restore();
  doc.save().rect(M, y, CW, h).lineWidth(0.7).strokeColor(C.boxBorder).stroke().restore();
  doc.save().rect(M, y, 3.5, h).fill(C.navy).restore();

  const cols = [
    { x: M + 15, label: 'AIRLINE RESERVATION (PNR)', value: d.pnr, color: C.ink },
    { x: M + 215, label: 'BOOKING ID / SYSTEM REF', value: d.bookingId, color: C.ink },
    { x: M + 405, label: 'STATUS', value: d.status, color: STATUS_COLOR[d.status] || C.orange },
  ];
  cols.forEach((c) => {
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5);
    t(doc, c.label, c.x, y + 10);
    doc.fillColor(c.color).font('Helvetica-Bold').fontSize(14);
    t(doc, c.value, c.x, y + 23);
  });
  return y + h + 16;
}

function travelerTable(doc, d, y) {
  y = sectionTitle(doc, 'TRAVELER INFORMATION', y);
  const cols = [
    { x: M, w: 220, h: 'Passenger Name' },
    { x: M + 220, w: 80, h: 'Passport No.' },
    { x: M + 300, w: 104, h: 'Check-in Baggage' },
    { x: M + 404, w: CW - 404, h: 'Cabin Baggage' },
  ];
  const headH = 21;
  doc.save().rect(M, y, CW, headH).fill(C.headBg).restore();
  doc.fillColor(C.body).font('Helvetica-Bold').fontSize(8.5);
  cols.forEach((c) => t(doc, c.h, c.x + 7, y + 7));
  const top = y;
  y += headH;

  d.passengers.forEach((p) => {
    const vals = [
      [p.title, p.name].filter(Boolean).join(' '),
      p.passport, String(p.checkin).toUpperCase(), String(p.cabin).toUpperCase(),
    ];
    doc.font('Helvetica-Bold').fontSize(9);
    const rowH = Math.max(21, ...vals.map((v, i) => doc.heightOfString(v || ' ', { width: cols[i].w - 14 }) + 12));
    doc.fillColor(C.ink);
    vals.forEach((v, i) => doc.text(v, cols[i].x + 7, y + 6.5, { width: cols[i].w - 14 }));
    y += rowH;
    hline(doc, M, W - M, y);
  });

  // grid
  doc.save().rect(M, top, CW, y - top).lineWidth(0.7).strokeColor(C.rule).stroke().restore();
  hline(doc, M, W - M, top + headH);
  cols.slice(1).forEach((c) => {
    doc.save().strokeColor(C.rule).lineWidth(0.7).moveTo(c.x, top).lineTo(c.x, y).stroke().restore();
  });
  return y + 22;
}

function flightHeader(doc, y) {
  const h = 22;
  doc.save().rect(M, y, CW, h).fill(C.headBg).restore();
  hline(doc, M, W - M, y, C.navy, 1.4);
  hline(doc, M, W - M, y + h, C.navy, 1.4);
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(8.5);
  t(doc, 'FLIGHT', COL.flight[0], y + 7.5);
  t(doc, 'DEPARTURE', COL.dep[0], y + 7.5);
  t(doc, 'ARRIVAL', COL.arr[0], y + 7.5);
  t(doc, 'CLASS', COL.cls[0], y + 7.5);
  t(doc, 'DURATION', COL.dur[0], y + 7.5, { width: COL.dur[1], align: 'right' });
  return y + h;
}

function flightNumber(s) {
  const raw = String(s.flightNo || '').toUpperCase().replace(/[\s-]/g, '');
  const num = raw.startsWith(s.airlineCode) ? raw.slice(s.airlineCode.length) : raw;
  return `${s.airlineCode}-${num}`;
}

// "Hazrat Shahjalal International Airport" -> "Hazrat Shahjalal Intl"
function shortAirport(name) {
  return String(name || '').replace(/\bInternational\b/gi, 'Intl').replace(/\s+Airport$/i, '').trim();
}

function airportLines(city, code, time, date, fullName, terminal) {
  const name = shortAirport(fullName);
  return [
    { text: `${city} (${code})`, font: 'Helvetica-Bold', size: 9.5, color: C.ink },
    { text: time, font: 'Helvetica-Bold', size: 9.5, color: C.ink },
    { text: date, font: 'Helvetica', size: 8, color: C.muted },
    { text: terminal ? `${name} - Terminal: ${terminal}` : name, font: 'Helvetica', size: 8, color: C.muted },
  ];
}

function segmentRow(doc, s, cabin, y) {
  const cells = {
    flight: [
      { text: s.airlineName, font: 'Helvetica-Bold', size: 9.5, color: C.ink },
      { text: flightNumber(s), font: 'Helvetica', size: 9, color: C.body },
      { text: s.aircraft || 'Equipment varies', font: 'Helvetica', size: 8, color: C.muted },
    ],
    dep: airportLines(s.from.city, s.from.code, s.depTime, s.depDate, s.from.name, s.fromTerminal),
    arr: airportLines(s.to.city, s.to.code, s.arrTime, s.arrDate, s.to.name, s.toTerminal),
    cls: [{ text: cabin, font: 'Helvetica', size: 9.5, color: C.ink }],
    dur: [{ text: s.durationText, font: 'Helvetica', size: 8, color: C.muted }],
  };
  const pad = 7;
  const rowH = Math.max(...Object.keys(cells).map((k) => cellHeight(doc, cells[k], COL[k][1]))) + pad * 2;
  return {
    height: rowH,
    draw(yy) {
      Object.keys(cells).forEach((k) => {
        drawCell(doc, cells[k], COL[k][0], yy + pad, COL[k][1], k === 'dur' ? 'right' : 'left');
      });
      hline(doc, M, W - M, yy + rowH);
      return yy + rowH;
    },
  };
}

function layoverRow(doc, l, y) {
  const h = 21;
  const where = l.code ? `${l.city} (${l.code})` : l.city;
  doc.fillColor(C.orange).font('Helvetica-Oblique').fontSize(8.5);
  t(doc, `Change of plane | ${l.duration} Layover in ${where}`, M, y + 7, { width: CW, align: 'center' });
  hline(doc, M, W - M, y + h);
  return y + h;
}

function ensure(doc, y, need) {
  if (y + need > BOTTOM) {
    doc.addPage();
    return { y: TOP, broke: true };
  }
  return { y, broke: false };
}

function journeyTable(doc, j, y) {
  const cabin = String(j.cabin || 'Economy').replace(/\s+class$/i, '');
  const first = segmentRow(doc, j.segments[0], cabin, 0);
  ({ y } = ensure(doc, y, 22 + first.height));
  y = flightHeader(doc, y);

  j.segments.forEach((s) => {
    const row = segmentRow(doc, s, cabin, y);
    const need = row.height + (s.layoverBefore ? 21 : 0);
    const r = ensure(doc, y, need);
    y = r.broke ? flightHeader(doc, r.y) : r.y;
    if (s.layoverBefore) y = layoverRow(doc, s.layoverBefore, y);
    y = row.draw(y);
  });
  return y + 14;
}

function reminders(doc, y) {
  ({ y } = ensure(doc, y, 90));
  y = sectionTitle(doc, 'IMPORTANT INFORMATION & REMINDERS', y);
  const x = M + 12;
  const w = CW - 12;
  REMINDERS.forEach(([title, body]) => {
    doc.font('Helvetica').fontSize(8.5);
    const h = doc.heightOfString(`${title} ${body}`, { width: w, lineGap: 2 });
    ({ y } = ensure(doc, y, h + 6));
    doc.fillColor(C.body).font('Helvetica').fontSize(8.5);
    t(doc, '•', M + 2, y);
    doc.fillColor(C.ink).font('Helvetica-Bold').text(`${title} `, x, y, { width: w, lineGap: 2, continued: true })
      .fillColor(C.body).font('Helvetica').text(body, { width: w, lineGap: 2 });
    y = doc.y + 6;
  });
  return y;
}

function footers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    doc.fillColor(C.faint).font('Helvetica').fontSize(8);
    t(doc, `Page ${i + 1} of ${range.count}`, M, H - 40);
  }
}

async function generateTicket(input) {
  const d = normalize(input);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: 0, autoFirstPage: false, bufferPages: true,
      info: { Title: `Itinerary ${d.pnr}`, Author: d.agency.name || d.agency.brand || '', Subject: 'Flight itinerary' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.addPage();
    header(doc, d);
    let y = referenceBox(doc, d, 98);
    y = travelerTable(doc, d, y);
    ({ y } = ensure(doc, y, 120));
    y = sectionTitle(doc, 'FLIGHT ITINERARY', y);
    d.journeys.forEach((j) => { y = journeyTable(doc, j, y); });
    reminders(doc, y + 4);
    footers(doc);
    doc.end();
  });
}

module.exports = { generateTicket };

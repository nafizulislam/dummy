// Airline icon cache: assets/airlines/<CODE>.png, downloaded once on first use.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'airlines');
const SOURCE = (code) => `https://images.kiwi.com/airlines/128x128/${code}.png`;

const fileFor = (code) => path.join(DIR, `${code}.png`);

async function ensureLogo(code) {
  if (!/^[A-Z0-9]{2}$/.test(code)) return null;
  const f = fileFor(code);
  if (fs.existsSync(f)) return f;
  try {
    const res = await fetch(SOURCE(code), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200 || buf[0] !== 0x89) return null; // not a PNG
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(f, buf);
    return f;
  } catch (_) {
    return null; // offline: the PDF falls back to a coloured badge
  }
}

async function logosFor(codes) {
  const out = {};
  await Promise.all([...new Set(codes)].map(async (c) => { out[c] = await ensureLogo(c); }));
  return out;
}

module.exports = { logosFor };

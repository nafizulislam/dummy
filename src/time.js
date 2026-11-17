// Timezone-aware helpers so durations/layovers are computed from real local times.

function offsetMinutesAt(tz, utcMs) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((asUtc - Math.floor(utcMs / 60000) * 60000) / 60000);
}

// "2026-12-25" + "14:00" in tz -> UTC milliseconds
function localToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMinutesAt(tz, guess);
  const t = guess - off1 * 60000;
  const off2 = offsetMinutesAt(tz, t);
  return guess - off2 * 60000;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

function parts(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, dow };
}

// "Fri 25 Dec 2026, 14:00"
function fmtDateTime(date, time) {
  const { y, m, d, dow } = parts(date);
  return `${DAYS[dow]} ${pad(d)} ${MONTHS[m - 1]} ${y}, ${time}`;
}
// "25 Dec 2026"
function fmtDate(date) {
  const { y, m, d } = parts(date);
  return `${pad(d)} ${MONTHS[m - 1]} ${y}`;
}
// "Fri 25 Dec 2026"
function fmtDayDate(date) {
  const { y, m, d, dow } = parts(date);
  return `${DAYS[dow]} ${pad(d)} ${MONTHS[m - 1]} ${y}`;
}
// "2h 20m"
function fmtDuration(mins) {
  return `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`;
}
// "19h:30m"
function fmtLayover(mins) {
  return `${Math.floor(mins / 60)}h:${pad(mins % 60)}m`;
}

module.exports = { localToUtc, fmtDateTime, fmtDate, fmtDayDate, fmtDuration, fmtLayover };

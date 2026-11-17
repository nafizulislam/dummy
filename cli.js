// Usage: node cli.js samples/sample.json output/ticket.pdf
const fs = require('fs');
const path = require('path');
const { generateTicket } = require('./src/pdf');

(async () => {
  const [inFile = 'samples/sample.json', outFile = 'output/ticket.pdf'] = process.argv.slice(2);
  try {
    const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const pdf = await generateTicket(data);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, pdf);
    console.log(`Wrote ${outFile} (${pdf.length} bytes)`);
  } catch (e) {
    console.error(e.details ? 'Invalid data:\n - ' + e.details.join('\n - ') : e);
    process.exit(1);
  }
})();

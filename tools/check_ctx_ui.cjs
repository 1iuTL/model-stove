// Extract the inline <script> from index.html and syntax-check it.
// index.html has no build step -- a typo there only shows up at runtime,
// which for a GUI shell means a blank window and no error anywhere.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const m = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
if (!m.length) { console.error('no inline <script> found'); process.exit(1); }

const out = path.join(ROOT, '_inlined_check.js');
fs.writeFileSync(out, m.map((x) => x[1]).join('\n;\n'), 'utf8');
console.log(`extracted ${m.length} inline script block(s), ${m.map(x=>x[1].length).join('+')} chars -> ${out}`);

// Also sanity-check that the ids the new code touches actually exist in the markup.
// Missing ones surface at runtime as "Cannot set properties of null" -- i.e. a
// blank window with one red line in a console the user never opens.
const ids = [
  'ctxRange', 'ctxVal', 'ctxNote', 'ctxTickMin', 'ctxTickSafe', 'ctxTickMax',
  'kvs', 'kvVal', 'kvNote',
  'stSpeed', 'optProbe',
];
let bad = 0;
for (const id of ids) {
  const present = html.includes(`id="${id}"`);
  if (!present) { console.error(`MISSING id in markup: ${id}`); bad++; }
}
console.log(bad ? `${bad} missing id(s)` : 'all slider ids present in markup');

// Dev helper: print conversation problems the integrity checker finds in a transcript.
//   npx esbuild scripts/validate-file.ts --bundle --platform=node --outfile=dist/validate.js && node dist/validate.js <file.jsonl>
import fs from 'node:fs';
import { makeApplier, validate } from '../src/main/integrity';

const file = process.argv[2];
const a = makeApplier({});
const data = fs.readFileSync(file);
let start = 0, i = 0;
while (start < data.length) {
  let end = data.indexOf(0x0a, start);
  if (end === -1) end = data.length;
  const line = data.subarray(start, end);
  start = end + 1;
  if (line.length) a.process(i, line);
  i++;
}
for (const p of validate(a.before)) console.log(p.level, p.message);

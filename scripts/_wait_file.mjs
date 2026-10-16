// Blocks until the given file contains a line starting with EXIT= (or the time limit passes). Local helper.
import fs from 'node:fs';
const [file, minutes = '9'] = process.argv.slice(2);
const end = Date.now() + Number(minutes) * 60000;
while (Date.now() < end) {
  try {
    if (/^EXIT=/m.test(fs.readFileSync(file, 'utf8'))) break;
  } catch {
    /* not yet */
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(fs.readFileSync(file, 'utf8').slice(-700));

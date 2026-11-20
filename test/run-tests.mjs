// Node's --test only accepts globs from v21 on; importing the compiled files
// keeps `npm test` working on Node 18 and 20 too.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = 'dist-test';
const files = readdirSync(directory)
  .filter((file) => file.endsWith('.test.js'))
  .sort();

for (const file of files) {
  await import(pathToFileURL(join(process.cwd(), directory, file)).href);
}

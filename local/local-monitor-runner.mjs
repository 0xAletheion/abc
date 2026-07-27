import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'local-monitor-cdp-v2.mjs');

if (process.env.RAKUTEN_KEEP_ITEM !== '1') {
  await import(pathToFileURL(sourcePath).href);
} else {
  const source = await fs.readFile(sourcePath, 'utf8');
  const cleanupCall = 'await removeVerifiedItem(outcome.page);';
  const occurrences = source.split(cleanupCall).length - 1;

  if (occurrences !== 2) {
    throw new Error(`Expected two cleanup calls in local-monitor-cdp-v2.mjs, found ${occurrences}.`);
  }

  const retainedSource = source.replaceAll(
    cleanupCall,
    "result.diagnostics.push('Verified item retained in the dedicated profile for the visible setup test.');"
  );

  const generatedPath = path.join(directory, '.local-monitor-cdp-v2-keep-item.mjs');
  await fs.writeFile(generatedPath, retainedSource);
  await import(`${pathToFileURL(generatedPath).href}?run=${Date.now()}`);
}

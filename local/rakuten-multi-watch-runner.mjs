import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'rakuten-multi-watch.mjs');
const generatedPath = path.join(directory, '.rakuten-multi-watch-runtime.mjs');
let source = await fs.readFile(sourcePath, 'utf8');

const replacements = [
  {
    from: "    selectionOrder: ['size', 'colour'],\n    alertMode: 'stock'",
    to: "    selectionOrder: [],\n    preselected: { size: true, colour: true },\n    alertMode: 'stock'"
  },
  {
    from: "    selectionOrder: ['size'],\n    alertMode: 'stock'",
    to: "    selectionOrder: [],\n    preselected: { size: true },\n    alertMode: 'stock'"
  },
  {
    from: "    selection: {\n      size_selected: false,\n      colour_selected: watch.colour ? false : null\n    },",
    to: "    selection: {\n      size_selected: Boolean(watch.preselected?.size),\n      colour_selected: watch.colour ? Boolean(watch.preselected?.colour) : null\n    },"
  }
];

for (const replacement of replacements) {
  const count = source.split(replacement.from).length - 1;
  if (count !== 1) {
    throw new Error(`Expected exactly one runtime patch match, found ${count}: ${replacement.from}`);
  }
  source = source.replace(replacement.from, replacement.to);
}

await fs.writeFile(generatedPath, source);

if (process.env.RAKUTEN_PATCH_ONLY === '1') {
  console.log(`Generated patched multi-watch: ${generatedPath}`);
} else {
  await import(`${pathToFileURL(generatedPath).href}?run=${Date.now()}`);
}

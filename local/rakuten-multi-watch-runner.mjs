import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'rakuten-multi-watch.mjs');
const generatedPath = path.join(directory, '.rakuten-multi-watch-runtime.mjs');
let source = await fs.readFile(sourcePath, 'utf8');

const patches = [
  {
    pattern: /    selectionOrder: \['size', 'colour'\],\r?\n    alertMode: 'stock'/,
    replacement: "    selectionOrder: [],\n    preselected: { size: true, colour: true },\n    alertMode: 'stock'",
    description: '8173 L/white preselection'
  },
  {
    pattern: /    selectionOrder: \['size'\],\r?\n    alertMode: 'stock'/,
    replacement: "    selectionOrder: [],\n    preselected: { size: true },\n    alertMode: 'stock'",
    description: '8186 M preselection'
  },
  {
    pattern: /    selection: \{\r?\n      size_selected: false,\r?\n      colour_selected: watch\.colour \? false : null\r?\n    \},/,
    replacement: "    selection: {\n      size_selected: Boolean(watch.preselected?.size),\n      colour_selected: watch.colour ? Boolean(watch.preselected?.colour) : null\n    },",
    description: 'preselected result flags'
  }
];

for (const patch of patches) {
  const matches = source.match(new RegExp(patch.pattern.source, 'g')) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one runtime patch match for ${patch.description}, found ${matches.length}.`);
  }
  source = source.replace(patch.pattern, patch.replacement);
}

await fs.writeFile(generatedPath, source);

if (process.env.RAKUTEN_PATCH_ONLY === '1') {
  console.log(`Generated patched multi-watch: ${generatedPath}`);
} else {
  await import(`${pathToFileURL(generatedPath).href}?run=${Date.now()}`);
}

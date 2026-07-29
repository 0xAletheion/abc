import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const requested = String(process.argv[2] || '').trim();

if (!['8173', '8186'].includes(requested)) {
  throw new Error('Usage: node .\\local\\studio-single-runner.mjs 8173|8186');
}

const sourcePath = path.join(directory, 'studio-dartisan-watch.mjs');
let source = await fs.readFile(sourcePath, 'utf8');

const watchBlocks = {
  '8173': String.raw`const WATCHES = [
  {
    id: 'studio-dartisan-8173-l-white',
    name: "Studio D'Artisan 8173 white size L",
    url: 'https://item.rakuten.co.jp/barbizon/sd8173/?variantId=r-sku00000003',
    productPattern: /(?:STUDIO\s+D['’´]?\s*ARTISAN|ステュディオ.*ダルチザン).*8173|\b8173\b/i,
    size: 'L',
    sizeIndex: 2,
    sizeCount: 5,
    colour: 'white',
    colourAliases: ['white', 'ホワイト'],
    colourIndex: 0,
    colourCount: 1
  }
];`,
  '8186': String.raw`const WATCHES = [
  {
    id: 'studio-dartisan-8186-m',
    name: "Studio D'Artisan 8186 size M",
    url: 'https://item.rakuten.co.jp/auc-americanbass/10018065/',
    productPattern: /(?:STUDIO\s+D['’´]?\s*ARTISAN|ステュディオ.*ダルチザン).*8186|\b8186\b/i,
    size: 'M',
    sizeIndex: 0,
    sizeCount: 4,
    colour: null,
    colourAliases: [],
    colourIndex: null,
    colourCount: null
  }
];`
};

const watchStart = source.indexOf('const WATCHES = [');
const watchEndMarker = '\n\nfunction escapeRegExp';
const watchEnd = source.indexOf(watchEndMarker, watchStart);

if (watchStart < 0 || watchEnd < 0 || watchEnd <= watchStart) {
  throw new Error('Could not locate the WATCHES block in studio-dartisan-watch.mjs.');
}

source = source.slice(0, watchStart) + watchBlocks[requested] + source.slice(watchEnd);
source = source.replace(
  "const RESULT_FILE = path.join(ARTIFACT_DIR, 'result.json');",
  "const RESULT_FILE = path.join(ARTIFACT_DIR, 'studio-" + requested + "-result.json');"
);
source = source.replace(
  "const HISTORY_FILE = path.join(ARTIFACT_DIR, 'history.ndjson');",
  "const HISTORY_FILE = path.join(ARTIFACT_DIR, 'studio-" + requested + "-history.ndjson');"
);
source = source.replace(
  "const STATE_FILE = path.join(ARTIFACT_DIR, 'studio-watch-state.json');",
  "const STATE_FILE = path.join(ARTIFACT_DIR, 'studio-" + requested + "-state.json');"
);
source = source.replace(
  "base.environment = 'ordinary-chrome-cdp-three-watch-v5';",
  "base.environment = 'ordinary-chrome-cdp-studio-" + requested + "-isolated';"
);

const generatedPath = path.join(directory, '.studio-' + requested + '-runtime.mjs');
await fs.writeFile(generatedPath, source);

if (process.env.RAKUTEN_PATCH_ONLY === '1') {
  console.log('Generated isolated Studio runtime: ' + generatedPath);
} else {
  await import(pathToFileURL(generatedPath).href + '?run=' + Date.now());
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const artifactDirectory = path.join(root, 'artifacts-local');
const requested = String(process.argv[2] || '').trim();

if (!['8173', '8186'].includes(requested)) {
  throw new Error('Usage: node .\\local\\studio-single-runner.mjs 8173|8186');
}

const watchDefinitions = {
  '8173': {
    id: 'studio-dartisan-8173-l-white',
    name: "Studio D'Artisan 8173 white size L",
    url: 'https://item.rakuten.co.jp/barbizon/sd8173/?variantId=r-sku00000003',
    size: 'L',
    colour: 'white'
  },
  '8186': {
    id: 'studio-dartisan-8186-m',
    name: "Studio D'Artisan 8186 size M",
    url: 'https://item.rakuten.co.jp/auc-americanbass/10018065/',
    size: 'M',
    colour: null
  }
};

const selectedWatch = watchDefinitions[requested];
const resultPath = path.join(artifactDirectory, 'studio-' + requested + '-result.json');

function startingResult() {
  return {
    checked_at: new Date().toISOString(),
    environment: 'ordinary-chrome-cdp-studio-' + requested + '-isolated-starting',
    watches: [{
      id: selectedWatch.id,
      name: selectedWatch.name,
      url: selectedWatch.url,
      target_size: selectedWatch.size,
      target_colour: selectedWatch.colour,
      status: 'starting',
      diagnostics: ['Isolated runner started; preparing the generated runtime.'],
      error: null
    }],
    error: null
  };
}

async function writeGenerationError(error) {
  const message = error?.stack || error?.message || String(error);
  await fs.writeFile(resultPath, JSON.stringify({
    checked_at: new Date().toISOString(),
    environment: 'ordinary-chrome-cdp-studio-' + requested + '-generation-error',
    watches: [{
      id: selectedWatch.id,
      name: selectedWatch.name,
      url: selectedWatch.url,
      target_size: selectedWatch.size,
      target_colour: selectedWatch.colour,
      status: 'error',
      diagnostics: ['The isolated runner failed while generating its runtime, before Chrome automation began.'],
      error: message
    }],
    error: message
  }, null, 2));
}

await fs.mkdir(artifactDirectory, { recursive: true });
await fs.writeFile(resultPath, JSON.stringify(startingResult(), null, 2));

try {
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
  const functionStart = source.indexOf('function escapeRegExp', watchStart);

  if (watchStart < 0 || functionStart < 0 || functionStart <= watchStart) {
    throw new Error(
      'Could not locate the WATCHES/function boundary in studio-dartisan-watch.mjs. ' +
      'watchStart=' + watchStart + ', functionStart=' + functionStart + '.'
    );
  }

  source = source.slice(0, watchStart) + watchBlocks[requested] + '\n\n' + source.slice(functionStart);

  const replacements = [
    [
      "const RESULT_FILE = path.join(ARTIFACT_DIR, 'result.json');",
      "const RESULT_FILE = path.join(ARTIFACT_DIR, 'studio-" + requested + "-result.json');",
      'RESULT_FILE'
    ],
    [
      "const HISTORY_FILE = path.join(ARTIFACT_DIR, 'history.ndjson');",
      "const HISTORY_FILE = path.join(ARTIFACT_DIR, 'studio-" + requested + "-history.ndjson');",
      'HISTORY_FILE'
    ],
    [
      "const STATE_FILE = path.join(ARTIFACT_DIR, 'studio-watch-state.json');",
      "const STATE_FILE = path.join(ARTIFACT_DIR, 'studio-" + requested + "-state.json');",
      'STATE_FILE'
    ],
    [
      "base.environment = 'ordinary-chrome-cdp-three-watch-v5';",
      "base.environment = 'ordinary-chrome-cdp-studio-" + requested + "-isolated';",
      'environment'
    ],
    [
      "const page = context.pages().find(item => /rakuten\\.co\\.jp/i.test(item.url())) || context.pages()[0] || await context.newPage();",
      "const page = await context.newPage();\n    await page.bringToFront();",
      'fresh-page selection'
    ],
    [
      "await page.goto(watch.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });",
      "result.diagnostics.push('Opening fresh product tab: ' + watch.url);\n  await page.bringToFront();\n  await page.goto(watch.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });",
      'product navigation'
    ]
  ];

  for (const [oldText, newText, label] of replacements) {
    if (!source.includes(oldText)) {
      throw new Error('Could not locate the ' + label + ' source text in studio-dartisan-watch.mjs.');
    }
    source = source.replace(oldText, newText);
  }

  const generatedPath = path.join(directory, '.studio-' + requested + '-runtime.mjs');
  await fs.writeFile(generatedPath, source);

  if (process.env.RAKUTEN_PATCH_ONLY === '1') {
    console.log('Generated isolated Studio runtime: ' + generatedPath);
  } else {
    await import(pathToFileURL(generatedPath).href + '?run=' + Date.now());
  }
} catch (error) {
  await writeGenerationError(error);
  throw error;
}

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ATTEMPTS = 4;
const BASE_DELAYS_MS = [0, 20_000, 60_000, 120_000];
const CONGESTION_PATTERN = /アクセスが集中|アクセスが混み合|ページが表示しづら|しばらく時間をおいて|時間をおいて再度|try again later|temporarily unavailable|too many requests|service unavailable|http\s*(?:429|503)/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBrowserMonitor(attempt) {
  console.log(`\n=== Rakuten browser attempt ${attempt}/${MAX_ATTEMPTS} ===`);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['monitor-cart.mjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Only this wrapper writes GitHub outputs. This prevents conflicting
        // output values when an earlier congestion attempt is retried.
        GITHUB_OUTPUT: ''
      }
    });

    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
}

async function readAttemptResult() {
  let result = null;
  let html = '';

  try {
    result = JSON.parse(await fs.readFile('artifacts/result.json', 'utf8'));
  } catch {}

  try {
    html = await fs.readFile('artifacts/page.html', 'utf8');
  } catch {}

  return { result, html };
}

function isCongestionFailure(result, html) {
  const combined = [
    result?.error || '',
    ...(Array.isArray(result?.diagnostics) ? result.diagnostics : []),
    html
  ].join('\n');

  return CONGESTION_PATTERN.test(combined);
}

async function archiveAttempt(attempt) {
  const artifactsDir = 'artifacts';
  const historyDir = path.join(artifactsDir, 'history');
  const attemptDir = path.join(historyDir, `attempt-${attempt}`);

  await fs.mkdir(attemptDir, { recursive: true });
  const entries = await fs.readdir(artifactsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'history') continue;
    const source = path.join(artifactsDir, entry.name);
    const destination = path.join(attemptDir, entry.name);
    await fs.rename(source, destination).catch(async () => {
      if (entry.isDirectory()) {
        await fs.cp(source, destination, { recursive: true });
        await fs.rm(source, { recursive: true, force: true });
      } else {
        await fs.copyFile(source, destination);
        await fs.rm(source, { force: true });
      }
    });
  }
}

async function writeFinalOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;

  const lines = [
    `alert_triggered=${Boolean(result?.alert_triggered)}`,
    `w33_available=${Boolean(result?.w33?.genuinely_available)}`,
    `listed_price_jpy=${result?.listed_price_jpy ?? ''}`,
    `effective_price_jpy=${result?.effective_price_jpy ?? ''}`,
    `jpy_per_gbp=${result?.jpy_per_gbp ?? ''}`,
    `effective_price_gbp=${result?.effective_price_gbp ?? ''}`,
    `price_trigger_met=${Boolean(result?.price_trigger_met)}`,
    `gbp_trigger_met=${Boolean(result?.gbp_trigger_met)}`,
    `error_present=${Boolean(result?.error)}`
  ].join('\n') + '\n';

  await fs.appendFile(process.env.GITHUB_OUTPUT, lines);
}

async function main() {
  await fs.mkdir('artifacts', { recursive: true });

  let finalResult = null;
  let attemptsUsed = 0;
  let congestionRetries = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;

    if (attempt > 1) {
      const jitterMs = Math.floor(Math.random() * 10_001);
      const delayMs = BASE_DELAYS_MS[attempt - 1] + jitterMs;
      console.log(`Rakuten congestion retry: waiting ${(delayMs / 1000).toFixed(1)} seconds.`);
      await sleep(delayMs);
    }

    const exitCode = await runBrowserMonitor(attempt);
    const { result, html } = await readAttemptResult();
    finalResult = result;

    if (!result) {
      console.log(`Attempt ${attempt} produced no result.json (exit code ${exitCode}).`);
      if (attempt < MAX_ATTEMPTS) {
        congestionRetries += 1;
        await archiveAttempt(attempt);
        continue;
      }
      break;
    }

    if (!result.error) {
      console.log(`Attempt ${attempt} completed without a monitor error.`);
      break;
    }

    const congestion = isCongestionFailure(result, html);
    console.log(`Attempt ${attempt} failed. Congestion detected: ${congestion}.`);

    if (!congestion || attempt === MAX_ATTEMPTS) break;

    congestionRetries += 1;
    await archiveAttempt(attempt);
  }

  if (!finalResult) {
    finalResult = {
      alert_triggered: false,
      listed_price_jpy: null,
      effective_price_jpy: null,
      jpy_per_gbp: null,
      effective_price_gbp: null,
      price_trigger_met: false,
      gbp_trigger_met: false,
      w33: { genuinely_available: false },
      diagnostics: [],
      error: 'Browser monitor did not produce result.json after all attempts.'
    };
  }

  finalResult.retry = {
    attempts_used: attemptsUsed,
    congestion_retries: congestionRetries,
    maximum_attempts: MAX_ATTEMPTS
  };
  finalResult.diagnostics = Array.isArray(finalResult.diagnostics) ? finalResult.diagnostics : [];
  finalResult.diagnostics.push(
    `Retry wrapper: attempts=${attemptsUsed}, congestionRetries=${congestionRetries}, maximum=${MAX_ATTEMPTS}`
  );

  await fs.writeFile('artifacts/result.json', JSON.stringify(finalResult, null, 2));
  console.log('\n=== Final Rakuten monitor result ===');
  console.log(JSON.stringify(finalResult, null, 2));
  await writeFinalOutputs(finalResult);
}

await main();

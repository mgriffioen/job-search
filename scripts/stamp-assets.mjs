#!/usr/bin/env node
/**
 * Cache-busting stamps for the page's own assets.
 *
 * The board fetches its data with `?t=<now>`, so the listings are never stale.
 * The code had no such protection: `index.html` referenced `app.js` and
 * `styles.css` by bare name, GitHub Pages serves them with a ten-minute
 * max-age and a long heuristic freshness after that, and a browser that had the
 * site open across a deploy kept running the old script against the new data.
 *
 * That is not a hypothetical. It is what happened when the ratings shipped: the
 * board showed the new postings and the new scores — fetched fresh — with the
 * old JavaScript, so the 👍 / 👎 / 🚫 row simply was not there, and no amount
 * of reloading the data would have brought it back.
 *
 * So every asset URL carries a hash of its own contents. Change the file and
 * the URL changes; leave it alone and the stamp is byte-identical, so this is
 * safe to run on every build and produces no diff of its own.
 *
 *   node scripts/stamp-assets.mjs           rewrite the stamps
 *   node scripts/stamp-assets.mjs --check   fail if they are out of date
 *
 * The check runs in the test suite, which runs in the workflow before anything
 * is published — so a forgotten stamp fails loudly rather than silently
 * shipping code nobody can see.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DOCS = new URL('../docs/', import.meta.url);

/** Short, stable, and long enough that two versions never collide in practice. */
function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 10);
}

/** The file as authored, with any previous stamp removed. */
function unstamped(source) {
  return source.replace(/(\.(?:mjs|js|css))\?v=[0-9a-f]{10}/g, '$1');
}

/**
 * Works out what every file should contain, in dependency order: the module
 * app.js imports is stamped first, so app.js's own hash already accounts for
 * the version of its dependency. Change preferences.mjs and both URLs move,
 * which is the point — a new app.js that pulled a cached preferences.mjs would
 * be a subtler version of the same bug.
 */
export async function planStamps() {
  const read = async (name) => unstamped(await readFile(new URL(name, DOCS), 'utf8'));

  const preferences = await read('preferences.mjs');
  const styles = await read('styles.css');

  const preferencesHash = hash(preferences);
  const stylesHash = hash(styles);

  const app = (await read('app.js')).replace(
    /from '\.\/preferences\.mjs'/,
    `from './preferences.mjs?v=${preferencesHash}'`
  );
  const appHash = hash(app);

  const html = (await read('index.html'))
    .replace(/href="styles\.css"/, `href="styles.css?v=${stylesHash}"`)
    .replace(/src="app\.js"/, `src="app.js?v=${appHash}"`);

  return [
    { name: 'app.js', content: app },
    { name: 'index.html', content: html },
    { name: 'preferences.mjs', content: preferences },
    { name: 'styles.css', content: styles },
  ];
}

/** Which files are not what they should be. Empty means everything is current. */
export async function outdatedStamps() {
  const plan = await planStamps();
  const stale = [];
  for (const file of plan) {
    const current = await readFile(new URL(file.name, DOCS), 'utf8');
    if (current !== file.content) stale.push(file.name);
  }
  return stale;
}

async function main() {
  const check = process.argv.includes('--check');

  if (check) {
    const stale = await outdatedStamps();
    if (!stale.length) {
      console.log('Asset stamps are up to date.');
      return;
    }
    console.error(
      `Asset stamps are out of date in: ${stale.join(', ')}\n` +
        'Run "npm run stamp" and commit the result, or the deploy will serve ' +
        'new code from a URL browsers already have cached.'
    );
    process.exit(1);
  }

  const plan = await planStamps();
  const written = [];
  for (const file of plan) {
    const current = await readFile(new URL(file.name, DOCS), 'utf8');
    if (current === file.content) continue;
    await writeFile(new URL(file.name, DOCS), file.content);
    written.push(file.name);
  }
  console.log(written.length ? `Stamped: ${written.join(', ')}` : 'Nothing to stamp — already current.');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

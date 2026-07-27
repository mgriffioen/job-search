/** Text helpers shared by every source adapter. */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ntilde: 'ñ',
  trade: '™',
  reg: '®',
  copy: '©',
};

export function decodeEntities(input = '') {
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
    });
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Strip markup down to readable plain text. Also used before any UI rendering. */
export function stripHtml(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

export function excerpt(text = '', maxChars = 460) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${cut.slice(0, lastStop > 120 ? lastStop : maxChars).trim()}…`;
}

/**
 * Lowercase, collapse punctuation to spaces, pad with spaces.
 * Padding lets callers do whole-word matching with a plain `includes`.
 */
export function normalizeForMatch(text = '') {
  const lowered = String(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
  return (
    ` ${lowered
      // Slashes and hyphens are separators, so "copy-editing" and
      // "QA/proofreading" match the phrases "copy editing" and "proofreading".
      // "+", "#" and "." survive because they carry meaning: c#, .net, 3.5.
      .replace(/[^a-z0-9+#. ]+/g, ' ')
      // …but a period that ends a sentence must not glue itself to the word.
      .replace(/\.(?![a-z0-9])/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()} `
  );
}

/** Whole-word/phrase containment against text already run through normalizeForMatch. */
export function containsPhrase(normalizedText, phrase) {
  const needle = normalizeForMatch(phrase).trim();
  if (!needle) return false;
  return normalizedText.includes(` ${needle} `);
}

export function slugify(text = '') {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Heuristic: 10-digit values are seconds, 13-digit are milliseconds.
    if (n < 1e12) n *= 1000;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  let raw = String(value).trim();
  // "2024-05-01 12:00:00" (Jobicy) is not reliably parsed across runtimes.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) raw = `${raw.replace(' ', 'T')}Z`;
  // Bare "2024-05-01T12:00:00" with no zone: treat as UTC rather than local.
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) raw = `${raw}Z`;

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function daysBetween(isoDate, now = new Date()) {
  if (!isoDate) return null;
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / 86400000;
}

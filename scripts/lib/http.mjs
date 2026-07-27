/**
 * Tiny fetch wrapper: timeouts, retries with backoff, and a browser-ish
 * User-Agent (several of these public job APIs reject the default Node UA).
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0 Safari/537.36 job-search-board/1.0 (personal job search aggregator)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(url, options = {}) {
  const {
    timeoutMs = 25000,
    retries = 2,
    accept = 'application/json, text/plain, */*',
    headers = {},
    method = 'GET',
    body,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': DEFAULT_UA, Accept: accept, ...headers },
      });
      if (!res.ok) {
        // 4xx (other than 429) will not get better by retrying.
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), {
          retryable: true,
        });
      }
      return await res.text();
    } catch (err) {
      lastError = err;
      const retryable = err.retryable || err.name === 'AbortError' || err.name === 'TypeError';
      if (attempt === retries || !retryable) break;
      await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function getJson(url, options = {}) {
  const body = await request(url, options);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Response from ${url} was not valid JSON (got ${body.slice(0, 80)}…)`);
  }
}

export async function getText(url, options = {}) {
  return request(url, { accept: 'application/rss+xml, application/xml, text/xml, */*', ...options });
}

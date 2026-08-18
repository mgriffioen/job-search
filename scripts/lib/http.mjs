/**
 * Tiny fetch wrapper: timeouts, retries with backoff, and a browser-ish
 * User-Agent (several of these public job APIs reject the default Node UA).
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0 Safari/537.36 job-search-board/1.0 (personal job search aggregator)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The full response: body plus headers. Metered APIs report what is left of the
 * quota in the headers, which is worth more than a tally we keep ourselves.
 */
export async function requestWithHeaders(url, options = {}) {
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
        // Carried on the error so a caller metering itself can still read the
        // quota headers off a 429 — the one response where they matter most.
        const failure = Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), {
          status: res.status,
          headers: res.headers,
        });
        // 4xx (other than 429) will not get better by retrying.
        if (res.status < 500 && res.status !== 429) throw failure;
        throw Object.assign(failure, { retryable: true });
      }
      return { body: await res.text(), headers: res.headers, status: res.status };
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

export async function request(url, options = {}) {
  const { body } = await requestWithHeaders(url, options);
  return body;
}

function parseJson(body, url) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Response from ${url} was not valid JSON (got ${body.slice(0, 80)}…)`);
  }
}

export async function getJson(url, options = {}) {
  return parseJson(await request(url, options), url);
}

/** As getJson, but keeps the response headers — see requestWithHeaders. */
export async function getJsonWithHeaders(url, options = {}) {
  const { body, headers } = await requestWithHeaders(url, options);
  return { data: parseJson(body, url), headers };
}

export async function getText(url, options = {}) {
  return request(url, { accept: 'application/rss+xml, application/xml, text/xml, */*', ...options });
}

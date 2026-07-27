/**
 * We Work Remotely — public RSS feeds, no key.
 * Titles arrive as "Company Name: Job Title".
 */

import { getText } from '../lib/http.mjs';
import { parseRssItems, tagText } from '../lib/xml.mjs';

export const id = 'weworkremotely';
export const label = 'We Work Remotely';
export const enabled = true;

const FEEDS = [
  'https://weworkremotely.com/categories/remote-marketing-jobs.rss',
  'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',
  'https://weworkremotely.com/categories/remote-design-jobs.rss',
  'https://weworkremotely.com/categories/remote-product-jobs.rss',
  'https://weworkremotely.com/categories/all-other-remote-jobs.rss',
];

function splitTitle(rawTitle) {
  const idx = rawTitle.indexOf(':');
  if (idx > 0 && idx < rawTitle.length - 1) {
    return { company: rawTitle.slice(0, idx).trim(), title: rawTitle.slice(idx + 1).trim() };
  }
  return { company: '', title: rawTitle.trim() };
}

export async function fetchJobs() {
  const jobs = [];

  for (const feed of FEEDS) {
    const xml = await getText(feed);
    for (const item of parseRssItems(xml)) {
      const { company, title } = splitTitle(item.title || '');
      if (!title) continue;
      const region = item.region || tagText(item.raw, 'region');
      jobs.push({
        sourceId: item.guid || item.link,
        title,
        company: company || tagText(item.raw, 'company'),
        url: item.link,
        description: item.description,
        location: region,
        locationRestriction: region,
        employmentTypes: item.type ? [item.type] : [],
        postedAt: item.pubDate,
        tags: item.category ? item.category.split(',').map((t) => t.trim()) : [],
        remoteFlag: true,
      });
    }
  }

  return jobs;
}

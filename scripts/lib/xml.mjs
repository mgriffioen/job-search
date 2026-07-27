/** Minimal RSS/Atom item reader — enough for job feeds, no dependency needed. */

import { decodeEntities } from './text.mjs';

function unwrap(value = '') {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decodeEntities(value);
}

/** Returns the text of the first `<tag>` inside `xml`. */
export function tagText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? unwrap(match[1]).trim() : '';
}

/** Returns every `<tag>` block inside `xml`. */
export function tagBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Attribute value from a self-closing tag, e.g. Atom's <link href="…"/>. */
export function attrValue(xml, tag, attr) {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, 'i'));
  return match ? decodeEntities(match[1]).trim() : '';
}

export function parseRssItems(xml) {
  const blocks = tagBlocks(xml, 'item').concat(tagBlocks(xml, 'entry'));
  return blocks.map((block) => ({
    title: tagText(block, 'title'),
    link: tagText(block, 'link') || attrValue(block, 'link', 'href'),
    guid: tagText(block, 'guid') || tagText(block, 'id'),
    pubDate: tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated'),
    description: tagText(block, 'description') || tagText(block, 'content:encoded') || tagText(block, 'summary') || tagText(block, 'content'),
    category: tagBlocks(block, 'category').map(unwrap).join(', ') || tagText(block, 'category'),
    region: tagText(block, 'region'),
    type: tagText(block, 'type'),
    raw: block,
  }));
}

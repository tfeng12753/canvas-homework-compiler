// A service worker has no DOMParser, so links are pulled out of Canvas page-body HTML
// with a regex rather than real DOM parsing. Good enough for well-formed rich-text links.

const LINK_RE = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
// Canvas frequently embeds a PDF/image as an inline preview <iframe> rather than a plain
// link (e.g. its rich-content editor auto-previews PDFs) — these carry no visible link
// text, so a plain <a> scan alone misses them.
const IFRAME_RE = /<iframe\s+[^>]*src="([^"]+)"[^>]*>/gi;

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLinks(html, baseUrl) {
  if (!html) return [];
  const origin = new URL(baseUrl).origin;
  const links = [];
  const seen = new Set();

  const addLink = (href, text) => {
    let resolved;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (resolved.origin !== origin) return;
    const key = resolved.pathname;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ text, href: resolved.pathname + resolved.search });
  };

  let match;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(html))) {
    const [, href, innerHtml] = match;
    const text = stripTags(innerHtml);
    if (text) addLink(href, text);
  }

  IFRAME_RE.lastIndex = 0;
  while ((match = IFRAME_RE.exec(html))) {
    addLink(match[1], '(embedded file preview)');
  }

  return links;
}

export function classifyLink(href) {
  const pageMatch = href.match(/\/courses\/\d+\/pages\/([^/?#]+)/);
  if (pageMatch) return { kind: 'page', slug: pageMatch[1] };

  const fileMatch = href.match(/\/(?:courses\/\d+\/)?files\/(\d+)/);
  if (fileMatch) return { kind: 'file', fileId: fileMatch[1] };

  return null;
}

// Parses a full Canvas URL a user pastes directly (e.g. from their address bar) into a
// {courseId, kind, slug|fileId} descriptor, for manually force-including one specific item.
export function parseCanvasContentUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  const pageMatch = u.pathname.match(/\/courses\/(\d+)\/pages\/([^/?#]+)/);
  if (pageMatch) return { courseId: pageMatch[1], kind: 'page', slug: pageMatch[2] };

  const courseFileMatch = u.pathname.match(/\/courses\/(\d+)\/files\/(\d+)/);
  if (courseFileMatch) return { courseId: courseFileMatch[1], kind: 'file', fileId: courseFileMatch[2] };

  return null;
}

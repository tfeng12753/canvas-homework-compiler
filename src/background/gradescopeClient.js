// Gradescope has no public REST API / personal access token, unlike Canvas. This client
// runs fetches inside a real, logged-in Gradescope tab (same technique as canvasScraper.js)
// and parses the returned HTML *inside that tab* (where DOMParser/document actually exist —
// the background service worker has neither). Parsing keys off structural patterns that
// change rarely (course/assignment link hrefs, <time datetime> elements) rather than CSS
// class names, since Gradescope's markup/classes are undocumented and can shift.

const ORIGIN = 'https://www.gradescope.com';

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function findOrOpenGradescopeTab() {
  const tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  if (tabs[0]) return tabs[0];
  const tab = await chrome.tabs.create({ url: `${ORIGIN}/account`, active: false });
  await waitForTabComplete(tab.id);
  return tab;
}

export class GradescopeClient {
  constructor() {
    this._tab = null;
  }

  async _tabId() {
    if (!this._tab) this._tab = await findOrOpenGradescopeTab();
    return this._tab.id;
  }

  async checkSession() {
    const tabId = await this._tabId();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        return { ok: res.ok && res.url.includes('/account'), status: res.status };
      },
      args: [`${ORIGIN}/account`],
    });
    if (!result.ok) return { ok: false, error: `Gradescope session check failed (${result.status}). Make sure you're logged in.` };
    return { ok: true };
  }

  async listCourses() {
    const tabId = await this._tabId();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return { error: res.status };
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const seen = new Set();
        const courses = [];
        doc.querySelectorAll('a[href^="/courses/"]').forEach((a) => {
          const m = a.getAttribute('href').match(/^\/courses\/(\d+)\/?$/);
          const name = a.textContent.trim();
          if (m && name && !seen.has(m[1])) {
            seen.add(m[1]);
            courses.push({ id: m[1], name });
          }
        });
        return { courses };
      },
      args: [`${ORIGIN}/account`],
    });
    if (result.error) throw new Error(`Failed to list Gradescope courses: ${result.error}`);
    return result.courses;
  }

  async listAssignments(courseId) {
    const tabId = await this._tabId();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return { error: res.status };
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const items = [];
        const linkEls = doc.querySelectorAll('a[href*="/assignments/"]');
        const seenHref = new Set();
        for (const link of linkEls) {
          const href = link.getAttribute('href');
          const title = link.textContent.trim();
          if (!title || seenHref.has(href)) continue;
          seenHref.add(href);
          // Look for a due-date <time> near this assignment link (same row/container).
          const row = link.closest('tr') || link.closest('li') || link.parentElement;
          const timeEl = row ? row.querySelector('time[datetime]') : null;
          items.push({
            href,
            title,
            dueAt: timeEl ? timeEl.getAttribute('datetime') : null,
          });
        }
        return { items };
      },
      args: [`${ORIGIN}/courses/${courseId}/assignments`],
    });
    if (result.error) throw new Error(`Failed to list Gradescope assignments: ${result.error}`);
    return result.items;
  }
}

export function normalizeGradescopeAssignment(course, item) {
  const idMatch = item.href.match(/\/assignments\/(\d+)/);
  const id = idMatch ? idMatch[1] : item.href;
  return {
    id: `gradescope-${course.id}-${id}`,
    source: 'gradescope',
    course: { id: `gs-${course.id}`, name: course.name },
    type: 'gradescope_assignment',
    title: item.title,
    url: `${ORIGIN}${item.href}`,
    dueAt: item.dueAt,
    updatedAt: null,
    moduleContext: null,
    descriptionHtml: '',
    attachments: [],
  };
}

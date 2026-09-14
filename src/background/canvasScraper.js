// Fallback path for schools that block personal API tokens: instead of a bearer
// token, we run fetches *inside* an actual Canvas tab the user is logged into, so
// requests carry the browser's normal session cookies — same API endpoints, just
// authenticated the way the Canvas web app itself authenticates.

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

async function findOrOpenCanvasTab(origin) {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  if (tabs[0]) return tabs[0];
  const tab = await chrome.tabs.create({ url: `${origin}/courses`, active: false });
  await waitForTabComplete(tab.id);
  return tab;
}

async function fetchJsonInTab(tabId, path) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (p) => {
      try {
        const res = await fetch(p, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return { error: res.status };
        return { data: await res.json(), link: res.headers.get('Link') };
      } catch (e) {
        return { error: String(e) };
      }
    },
    args: [path],
  });
  return result;
}

async function downloadFileInTab(tabId, url) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (fileUrl) => {
      const res = await fetch(fileUrl, { credentials: 'include' });
      if (!res.ok) return { error: res.status };
      const buf = await res.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { base64: btoa(binary) };
    },
    args: [url],
  });
  return result;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const [urlPart, relPart] = part.split(';').map((s) => s.trim());
    if (relPart === 'rel="next"') return urlPart.slice(1, -1);
  }
  return null;
}

export class CanvasScrapeClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.origin = new URL(this.baseUrl).origin;
    this._tab = null;
  }

  async _tabId() {
    if (!this._tab) this._tab = await findOrOpenCanvasTab(this.origin);
    return this._tab.id;
  }

  async fetchAllPages(path) {
    const tabId = await this._tabId();
    let next = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const results = [];
    while (next) {
      const result = await fetchJsonInTab(tabId, next);
      if (result.error) throw new Error(`Scrape fetch failed (${result.error}) for ${next}`);
      results.push(...(Array.isArray(result.data) ? result.data : [result.data]));
      next = parseNextLink(result.link);
    }
    return results;
  }

  async checkSession() {
    const tabId = await this._tabId();
    const result = await fetchJsonInTab(tabId, `${this.baseUrl}/api/v1/users/self`);
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, user: result.data };
  }

  listActiveCourses() {
    return this.fetchAllPages('/api/v1/courses?enrollment_state=active&per_page=100&include[]=term');
  }

  listAssignments(courseId) {
    return this.fetchAllPages(`/api/v1/courses/${courseId}/assignments?per_page=100&order_by=due_at`);
  }

  listModules(courseId) {
    return this.fetchAllPages(`/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`);
  }

  listFiles(courseId) {
    return this.fetchAllPages(`/api/v1/courses/${courseId}/files?per_page=100`);
  }

  listFolders(courseId) {
    return this.fetchAllPages(`/api/v1/courses/${courseId}/folders?per_page=100`);
  }

  listPages(courseId) {
    return this.fetchAllPages(`/api/v1/courses/${courseId}/pages?per_page=100`);
  }

  async getPage(courseId, url) {
    const tabId = await this._tabId();
    const result = await fetchJsonInTab(tabId, `${this.baseUrl}/api/v1/courses/${courseId}/pages/${url}`);
    if (result.error) throw new Error(`Scrape fetch failed: ${result.error}`);
    return result.data;
  }

  async getFrontPage(courseId) {
    const tabId = await this._tabId();
    const result = await fetchJsonInTab(tabId, `${this.baseUrl}/api/v1/courses/${courseId}/front_page`);
    if (result.error) throw new Error(`Scrape fetch failed: ${result.error}`);
    return result.data;
  }

  async getFile(fileId) {
    const tabId = await this._tabId();
    const result = await fetchJsonInTab(tabId, `${this.baseUrl}/api/v1/files/${fileId}`);
    if (result.error) throw new Error(`Scrape fetch failed: ${result.error}`);
    return result.data;
  }

  async downloadFile(fileUrl) {
    const tabId = await this._tabId();
    const result = await downloadFileInTab(tabId, fileUrl);
    if (result.error) throw new Error(`Scrape file download failed: ${result.error}`);
    const binary = atob(result.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
}

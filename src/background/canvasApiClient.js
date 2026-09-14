function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const [urlPart, relPart] = part.split(';').map((s) => s.trim());
    if (relPart === 'rel="next"') {
      return urlPart.slice(1, -1);
    }
  }
  return null;
}

export class CanvasApiClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async request(path) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const err = new Error(`Canvas API ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async fetchAllPages(path) {
    let next = path;
    const results = [];
    while (next) {
      const res = await this.request(next);
      const page = await res.json();
      results.push(...(Array.isArray(page) ? page : [page]));
      next = parseNextLink(res.headers.get('Link'));
    }
    return results;
  }

  async validateToken() {
    try {
      const res = await this.request('/api/v1/users/self');
      const user = await res.json();
      return { ok: true, user };
    } catch (err) {
      return { ok: false, status: err.status ?? null, error: String(err) };
    }
  }

  async listActiveCourses() {
    return this.fetchAllPages(
      '/api/v1/courses?enrollment_state=active&per_page=100&include[]=term'
    );
  }

  async listAssignments(courseId) {
    return this.fetchAllPages(
      `/api/v1/courses/${courseId}/assignments?per_page=100&order_by=due_at`
    );
  }

  async listModules(courseId) {
    return this.fetchAllPages(
      `/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`
    );
  }

  async listFiles(courseId) {
    return this.fetchAllPages(`/api/v1/courses/${courseId}/files?per_page=100`);
  }

  async listFolders(courseId) {
    return this.fetchAllPages(`/api/v1/courses/${courseId}/folders?per_page=100`);
  }

  async listPages(courseId) {
    return this.fetchAllPages(`/api/v1/courses/${courseId}/pages?per_page=100`);
  }

  async getPage(courseId, url) {
    const res = await this.request(
      `/api/v1/courses/${courseId}/pages/${url}`
    );
    return res.json();
  }

  async getFrontPage(courseId) {
    const res = await this.request(`/api/v1/courses/${courseId}/front_page`);
    return res.json();
  }

  async getFile(fileId) {
    const res = await this.request(`/api/v1/files/${fileId}`);
    return res.json();
  }

  async downloadFile(fileUrl) {
    const res = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
    return res.arrayBuffer();
  }
}

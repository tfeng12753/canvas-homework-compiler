import { CanvasApiClient } from './canvasApiClient.js';
import { CanvasScrapeClient } from './canvasScraper.js';
import {
  normalizeAssignment,
  normalizeFile,
  normalizeModuleItem,
  normalizePage,
  withinRange,
} from './normalizer.js';
import {
  classifyItems,
  extractQuestions,
  findRelevantLinks,
  generateSimilarProblems,
  stripHtml,
} from './llmClient.js';
import { extractTextFromAttachment } from './fileExtractor.js';
import { compileMarkdown, compileFlatQuestionList, markdownToPrintableHtml } from './compiler.js';
import { GradescopeClient, normalizeGradescopeAssignment } from './gradescopeClient.js';
import { getAuthToken, clearCachedToken, ensureHomeworkCalendar, upsertEvent } from './googleCalendarClient.js';
import { extractLinks, classifyLink, parseCanvasContentUrl } from './linkExtractor.js';

// Backstop against a pathologically page-heavy course, not a real limit — Canvas's own
// pagination already bounds the fetch. A lower cap here previously caused pages later in
// Canvas's default ordering (e.g. a "Homework" page alphabetically past other content) to
// be silently skipped, which is exactly the kind of bug a "force include this URL" escape
// hatch and this generous cap are both meant to prevent from recurring.
const MAX_PAGES_TO_SCAN = 200;

async function getSettings() {
  const s = await chrome.storage.local.get([
    'canvasBaseUrl',
    'canvasToken',
    'llmBaseUrl',
    'llmApiKey',
    'llmModel',
  ]);
  return s;
}

async function getClient(settings) {
  if (!settings.canvasBaseUrl) {
    throw new Error('Set your Canvas URL in the extension options first.');
  }
  if (settings.canvasToken) {
    const api = new CanvasApiClient(settings.canvasBaseUrl, settings.canvasToken);
    const check = await api.validateToken();
    if (check.ok) return { client: api, mode: 'api' };
  }
  const scrape = new CanvasScrapeClient(settings.canvasBaseUrl);
  const check = await scrape.checkSession();
  if (!check.ok) {
    throw new Error(
      'Could not authenticate with Canvas via API token or browser session. ' +
        'Make sure you are logged into Canvas in this browser, or check your token in options.'
    );
  }
  return { client: scrape, mode: 'scrape' };
}

async function listCourses() {
  const settings = await getSettings();
  const { client } = await getClient(settings);
  const courses = await client.listActiveCourses();
  return courses.map((c) => ({ id: c.id, name: c.name || c.course_code }));
}

// A Canvas Page is often just a shell of links to the actual homework files (exactly the
// case reported: a "Homework" page whose body is nothing but download links). The page
// itself is still added as a candidate (it may have real text too), but every file link
// found in its body is *also* pulled in as its own item, since that's usually where the
// real content lives.
async function expandPageAttachments(client, course, page, baseUrl) {
  const links = extractLinks(page.body || '', baseUrl);
  const fileLinks = links.filter((l) => classifyLink(l.href)?.kind === 'file');
  console.log(
    `[Homework Compiler] "${page.title}": ${links.length} link(s) found, ${fileLinks.length} look like files`
  );

  const fileItems = [];
  const seenFileIds = new Set();
  for (const link of fileLinks) {
    const { fileId } = classifyLink(link.href);
    if (seenFileIds.has(fileId)) continue;
    seenFileIds.add(fileId);
    try {
      const file = await client.getFile(fileId);
      const item = normalizeFile(course, file, page.title);
      if (item) {
        fileItems.push(item);
      } else {
        console.warn(`[Homework Compiler] File ${fileId} (${file.display_name}) on "${page.title}" isn't a PDF/docx/doc — skipped.`);
      }
    } catch (err) {
      console.error(`[Homework Compiler] Failed to fetch file ${fileId} linked from "${page.title}":`, err);
    }
  }
  return fileItems;
}

async function gatherCourseItems(client, course, baseUrl) {
  const items = [];

  const [assignments, modules, files, folders, pageSummaries] = await Promise.all([
    client.listAssignments(course.id).catch((err) => {
      console.error(`[Homework Compiler] listAssignments failed for ${course.name}:`, err);
      return [];
    }),
    client.listModules(course.id).catch(() => []),
    client.listFiles(course.id).catch((err) => {
      console.error(`[Homework Compiler] listFiles failed for ${course.name}:`, err);
      return [];
    }),
    client.listFolders(course.id).catch(() => []),
    client.listPages(course.id).catch((err) => {
      console.error(`[Homework Compiler] listPages failed for ${course.name}:`, err);
      return [];
    }),
  ]);
  console.log(
    `[Homework Compiler] ${course.name}: ${assignments.length} assignments, ${files.length} files, ${pageSummaries.length} pages found —`,
    pageSummaries.map((p) => p.title)
  );
  const folderNameById = new Map(folders.map((f) => [f.id, f.name]));

  for (const a of assignments) items.push(normalizeAssignment(course, a));
  for (const f of files) {
    const n = normalizeFile(course, f, folderNameById.get(f.folder_id) || null);
    if (n) items.push(n);
  }
  for (const mod of modules) {
    for (const item of mod.items || []) {
      items.push(normalizeModuleItem(course, mod, item));
    }
  }
  // Scanned directly as plain candidates so a page literally titled "Homework" is picked
  // up even if nothing links to it prominently. Capped since a page-per-course fan-out
  // could otherwise be large on a course with hundreds of wiki pages.
  for (const summary of pageSummaries.slice(0, MAX_PAGES_TO_SCAN)) {
    const full = await client.getPage(course.id, summary.url).catch(() => null);
    if (!full) continue;
    items.push(normalizePage(course, full));
    items.push(...(await expandPageAttachments(client, course, full, baseUrl)));
  }

  return items;
}

// Canvas has no fixed convention for where homework lives, so instead of hardcoding more
// keyword rules, this fetches the course's front page (homepage) and asks the LLM which of
// its outgoing links look like they lead to homework — then follows just those (one hop)
// to pull in whatever they point to. A course with no front page just skips this step.
async function crawlHomepageLinks(client, course, baseUrl, llmSettings, onProgress) {
  const front = await client.getFrontPage(course.id).catch(() => null);
  if (!front?.body) return [];

  const links = extractLinks(front.body, baseUrl);
  if (links.length === 0) return [];

  onProgress({ stage: 'crawl', message: `Checking homepage links for ${course.name}...` });
  const relevant = await findRelevantLinks(links, llmSettings).catch(() => []);

  const discovered = [];
  for (const link of relevant) {
    const target = classifyLink(link.href);
    if (!target) continue;
    try {
      if (target.kind === 'page') {
        const page = await client.getPage(course.id, target.slug);
        const item = normalizePage(course, page);
        item.moduleContext = link.text;
        discovered.push(item);
        discovered.push(...(await expandPageAttachments(client, course, page, baseUrl)));
      } else if (target.kind === 'file') {
        const file = await client.getFile(target.fileId);
        const item = normalizeFile(course, file, link.text);
        if (item) discovered.push(item);
      }
    } catch {
      // Couldn't resolve this particular link's target (deleted, permissions, etc.) — skip it.
    }
  }
  return discovered;
}

// Lets the user guarantee one specific page/file gets included and extracted, bypassing
// discovery heuristics and LLM classification entirely — for exactly the case where
// automatic discovery (pages scan, homepage crawl, folder/module naming) misses something
// the user already knows is homework.
async function resolveForceUrl(client, courses, url, baseUrl) {
  const parsed = parseCanvasContentUrl(url);
  if (!parsed) throw new Error(`Not a recognized Canvas page/file URL: ${url}`);

  const course = courses.find((c) => String(c.id) === String(parsed.courseId)) || {
    id: parsed.courseId,
    name: `Course ${parsed.courseId}`,
  };

  if (parsed.kind === 'page') {
    const page = await client.getPage(parsed.courseId, parsed.slug);
    const item = normalizePage(course, page);
    item.moduleContext = 'Homework';
    // The page itself, plus every file it links to — a page that's just a list of
    // download links (the reported case) would otherwise resolve to empty text.
    return [item, ...(await expandPageAttachments(client, course, page, baseUrl))];
  }
  if (parsed.kind === 'file') {
    const file = await client.getFile(parsed.fileId);
    const item = normalizeFile(course, file, 'Homework');
    if (!item) throw new Error(`${url} isn't a PDF/docx/doc file, so its text can't be extracted.`);
    return [item];
  }
  throw new Error(`Not a recognized Canvas page/file URL: ${url}`);
}

async function resolveAttachmentBuffer(client, item) {
  if (item.attachments.length === 0) return null;
  const att = item.attachments[0];
  const buf = await client.downloadFile(att.url);
  return { attachment: att, buffer: buf };
}

async function runCompile(
  {
    courseIds,
    startDateISO,
    endDateISO,
    ignoreDateRange,
    forceUrls = [],
    includeSolutions = false,
    flatQuestionList = false,
    generateSimilar = false,
  },
  onProgress
) {
  const settings = await getSettings();
  if (!settings.llmBaseUrl || !settings.llmApiKey || !settings.llmModel) {
    throw new Error('Set your LLM provider (base URL, API key, model) in the extension options first.');
  }
  const llmSettings = {
    baseUrl: settings.llmBaseUrl,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
  };

  const { client } = await getClient(settings);
  onProgress({ stage: 'auth', message: 'Connected to Canvas' });

  const allCourses = await client.listActiveCourses();
  const courses = allCourses
    .filter((c) => courseIds.includes(c.id))
    .map((c) => ({ id: c.id, name: c.name || c.course_code }));

  const startDate = new Date(startDateISO);
  const endDate = new Date(endDateISO);

  let allItems = [];
  for (const course of courses) {
    onProgress({ stage: 'fetch', message: `Fetching ${course.name}...` });
    const items = await gatherCourseItems(client, course, settings.canvasBaseUrl);
    allItems.push(...items);

    const discovered = await crawlHomepageLinks(
      client,
      course,
      settings.canvasBaseUrl,
      llmSettings,
      onProgress
    ).catch(() => []);
    allItems.push(...discovered);
  }

  let forcedItems = [];
  for (const url of forceUrls) {
    try {
      onProgress({ stage: 'force-url', message: `Loading forced URL: ${url}` });
      const resolved = await resolveForceUrl(client, courses, url, settings.canvasBaseUrl);
      console.log(`[Homework Compiler] Force URL ${url} resolved to ${resolved.length} item(s):`, resolved);
      forcedItems.push(...resolved);
    } catch (err) {
      console.error(`[Homework Compiler] Force URL ${url} failed:`, err);
      onProgress({ stage: 'force-url-error', message: `Skipped ${url}: ${err.message}` });
    }
  }
  if (!includeSolutions) forcedItems = forcedItems.filter((it) => !it.isSolution);
  const forcedIds = new Set(forcedItems.map((it) => it.id));

  const inRange = (ignoreDateRange ? allItems : allItems.filter((it) => withinRange(it, startDate, endDate)))
    .filter((it) => !forcedIds.has(it.id))
    .filter((it) => includeSolutions || !it.isSolution);
  onProgress({
    stage: 'filter',
    message: ignoreDateRange
      ? `${inRange.length} candidate items (date range ignored)`
      : `${inRange.length} candidate items in range`,
  });

  if (inRange.length === 0 && forcedItems.length === 0) {
    return { markdown: '# Homework Practice Compilation\n\nNo items found.', items: [] };
  }

  let homeworkItems = forcedItems;
  if (inRange.length > 0) {
    const classifications = await classifyItems(inRange, llmSettings, (done, total) =>
      onProgress({ stage: 'classify', message: `Classifying items ${done}/${total}` })
    );
    const classMap = new Map(classifications.map((c) => [c.id, c]));
    homeworkItems = [...forcedItems, ...inRange.filter((it) => classMap.get(it.id)?.isHomework)];
  }
  onProgress({ stage: 'classify-done', message: `${homeworkItems.length} items identified as homework` });

  const compiled = [];
  let done = 0;
  for (const item of homeworkItems) {
    onProgress({
      stage: 'extract',
      message: `Extracting questions ${++done}/${homeworkItems.length}: ${item.title}`,
    });

    // Pull whatever raw text is available first — attachment content if there's a file,
    // else the item's own page/assignment body — regardless of item type, so a file item
    // (which never has descriptionHtml) still gets a usable fallback if extraction fails.
    let rawText = null;
    const resolved = await resolveAttachmentBuffer(client, item).catch((err) => {
      console.error(`[Homework Compiler] Failed to download attachment for "${item.title}":`, err);
      return null;
    });
    if (resolved) {
      rawText = await extractTextFromAttachment(resolved.attachment, resolved.buffer);
      if (!rawText) {
        console.warn(
          `[Homework Compiler] No text extracted from "${resolved.attachment.name}" — likely a scanned/image-only PDF with no text layer.`
        );
      }
    }
    if (!rawText) {
      const descText = stripHtml(item.descriptionHtml);
      if (descText.length > 20) rawText = descText;
    }
    if (!rawText) {
      console.warn(`[Homework Compiler] "${item.title}" produced no usable text at all.`);
    }

    // A solutions/answer-key file should be kept intact for reference, not run through the
    // "extract questions, ignore answer keys" prompt — that would strip out exactly the
    // content the user wants to see.
    const extractedQuestions =
      rawText && !item.isSolution
        ? await extractQuestions(item.title, rawText, llmSettings).catch(() => null)
        : null;

    // Opt-in and only for real practice material (not solutions/answer keys, and not items
    // with nothing to base new problems on) — clearly kept separate from the extracted
    // originals downstream so it's never mistaken for the actual assignment content.
    let similarProblems = null;
    if (generateSimilar && !item.isSolution) {
      const basis = extractedQuestions && extractedQuestions !== 'NONE_FOUND' ? extractedQuestions : rawText;
      if (basis) {
        onProgress({ stage: 'generate', message: `Generating similar problems: ${item.title}` });
        similarProblems = await generateSimilarProblems(item.title, basis, llmSettings).catch((err) => {
          console.error(`[Homework Compiler] Failed to generate similar problems for "${item.title}":`, err);
          return null;
        });
      }
    }

    compiled.push({
      ...item,
      extractedQuestions,
      fallbackText: rawText ? rawText.slice(0, item.isSolution ? 4000 : 1500) : null,
      similarProblems,
    });
  }

  const markdown = flatQuestionList
    ? compileFlatQuestionList(compiled)
    : compileMarkdown(compiled, { startDate, endDate, ignoreDateRange });
  return { markdown, items: compiled };
}

async function listGradescopeCourses() {
  const gs = new GradescopeClient();
  const check = await gs.checkSession();
  if (!check.ok) throw new Error(check.error);
  return gs.listCourses();
}

async function runCalendarSync({ canvasCourseIds, gradescopeCourseIds, startDateISO, endDateISO }, onProgress) {
  const startDate = new Date(startDateISO);
  const endDate = new Date(endDateISO);
  const allItems = [];

  if (canvasCourseIds.length > 0) {
    const settings = await getSettings();
    const { client } = await getClient(settings);
    onProgress({ stage: 'auth', message: 'Connected to Canvas' });
    const allCourses = await client.listActiveCourses();
    const courses = allCourses
      .filter((c) => canvasCourseIds.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name || c.course_code }));
    for (const course of courses) {
      onProgress({ stage: 'fetch', message: `Fetching Canvas due dates: ${course.name}...` });
      const assignments = await client.listAssignments(course.id).catch(() => []);
      for (const a of assignments) allItems.push(normalizeAssignment(course, a));
    }
  }

  if (gradescopeCourseIds.length > 0) {
    const gs = new GradescopeClient();
    const check = await gs.checkSession();
    if (!check.ok) throw new Error(check.error);
    onProgress({ stage: 'auth', message: 'Connected to Gradescope' });
    const allCourses = await gs.listCourses();
    const courses = allCourses.filter((c) => gradescopeCourseIds.includes(c.id));
    for (const course of courses) {
      onProgress({ stage: 'fetch', message: `Fetching Gradescope due dates: ${course.name}...` });
      const assignments = await gs.listAssignments(course.id).catch(() => []);
      for (const a of assignments) allItems.push(normalizeGradescopeAssignment(course, a));
    }
  }

  const inRange = allItems.filter((it) => it.dueAt && withinRange(it, startDate, endDate));
  onProgress({ stage: 'filter', message: `${inRange.length} due dates in range` });
  if (inRange.length === 0) return { synced: 0, total: 0 };

  onProgress({ stage: 'auth-google', message: 'Connecting to Google Calendar…' });
  let token = await getAuthToken(true);
  const calendarId = await ensureHomeworkCalendar(token);

  let synced = 0;
  for (const item of inRange) {
    onProgress({ stage: 'sync', message: `Syncing ${synced + 1}/${inRange.length}: ${item.title}` });
    try {
      await upsertEvent(token, calendarId, item);
    } catch (err) {
      if (err.status === 401) {
        await clearCachedToken(token);
        token = await getAuthToken(true);
        await upsertEvent(token, calendarId, item);
      } else {
        throw err;
      }
    }
    synced++;
  }

  return { synced, total: inRange.length };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'compile') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type !== 'START') return;
      try {
        const result = await runCompile(msg.payload, (progress) =>
          port.postMessage({ type: 'PROGRESS', progress })
        );
        await chrome.storage.local.set({ lastResult: result });
        port.postMessage({ type: 'DONE', result });
      } catch (err) {
        port.postMessage({ type: 'ERROR', error: String(err.message || err) });
      }
    });
  } else if (port.name === 'calendar-sync') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type !== 'START') return;
      try {
        const result = await runCalendarSync(msg.payload, (progress) =>
          port.postMessage({ type: 'PROGRESS', progress })
        );
        port.postMessage({ type: 'DONE', result });
      } catch (err) {
        port.postMessage({ type: 'ERROR', error: String(err.message || err) });
      }
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'LIST_COURSES') {
    listCourses()
      .then((courses) => sendResponse({ ok: true, courses }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === 'TEST_CANVAS') {
    getSettings()
      .then(getClient)
      .then((r) => sendResponse({ ok: true, mode: r.mode }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === 'TEST_GRADESCOPE') {
    new GradescopeClient()
      .checkSession()
      .then((res) => (res.ok ? sendResponse({ ok: true }) : sendResponse({ ok: false, error: res.error })))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === 'LIST_GRADESCOPE_COURSES') {
    listGradescopeCourses()
      .then((courses) => sendResponse({ ok: true, courses }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === 'TEST_GOOGLE_CALENDAR') {
    getAuthToken(true)
      .then((token) => ensureHomeworkCalendar(token))
      .then((calendarId) => sendResponse({ ok: true, calendarId }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === 'EXPORT_PDF') {
    const html = markdownToPrintableHtml(msg.markdown, 'Homework Practice Compilation');
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    chrome.tabs.create({ url }, () => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

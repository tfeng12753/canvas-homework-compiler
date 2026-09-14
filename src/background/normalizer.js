// Shared item schema produced by both the API path and the scrape-fallback path:
// { id, source, course: {id, name}, type, title, url, dueAt, updatedAt,
//   moduleContext, descriptionHtml, attachments: [{name, url, contentType}] }

function isDocAttachment(file) {
  const name = (file.filename || file.display_name || '').toLowerCase();
  return name.endsWith('.pdf') || name.endsWith('.docx') || name.endsWith('.doc');
}

export function isSolutionName(name) {
  return !!name && /solutions?\b|answer[\s_-]?key|\bsoln\b/i.test(name);
}

export function normalizeAssignment(course, assignment) {
  return {
    id: `assignment-${assignment.id}`,
    source: 'api',
    course: { id: course.id, name: course.name },
    type: 'assignment',
    title: assignment.name,
    url: assignment.html_url,
    dueAt: assignment.due_at,
    updatedAt: assignment.updated_at,
    moduleContext: null,
    descriptionHtml: assignment.description || '',
    attachments: [],
  };
}

export function normalizeFile(course, file, folderName = null) {
  if (!isDocAttachment(file)) return null;
  return {
    id: `file-${file.id}`,
    source: 'api',
    course: { id: course.id, name: course.name },
    type: 'file',
    title: file.display_name,
    url: file.url,
    dueAt: null,
    updatedAt: file.updated_at || file.created_at,
    moduleContext: folderName,
    descriptionHtml: '',
    isSolution: isSolutionName(file.display_name) || isSolutionName(folderName),
    attachments: [
      { name: file.display_name, url: file.url, contentType: file['content-type'] },
    ],
  };
}

export function normalizeModuleItem(course, mod, item) {
  return {
    id: `moduleitem-${item.id}`,
    source: 'api',
    course: { id: course.id, name: course.name },
    type: `module_item:${item.type}`,
    title: item.title,
    url: item.html_url,
    dueAt: null,
    updatedAt: null,
    moduleContext: mod.name,
    descriptionHtml: '',
    attachments: [],
  };
}

export function normalizePage(course, page, mod) {
  return {
    id: `page-${page.page_id || page.url}`,
    source: 'api',
    course: { id: course.id, name: course.name },
    type: 'page',
    title: page.title,
    url: page.html_url,
    dueAt: null,
    updatedAt: page.updated_at,
    moduleContext: mod ? mod.name : null,
    descriptionHtml: page.body || '',
    attachments: [],
  };
}

function isHomeworkContainerName(name) {
  return (
    !!name &&
    // \bhw\d*\b (not \bhw\b) so this also matches "HW3", "HW-12", etc., not just a bare "HW".
    /homework|\bhw\d*\b|practice[\s_-]?(test|exam|quiz|problem)|review|study[\s_-]?guide|\bexam\b|midterm|\bfinal\b/i.test(
      name
    )
  );
}

export function withinRange(item, startDate, endDate) {
  // Files/modules/pages named things like "Homework", "Practice Exam", "Midterm Review",
  // etc. — either the item itself, or the folder/module it lives in — don't carry a due
  // date that means anything (a folder's upload date, a page's last-edited date, or no
  // date at all). The date range makes sense for graded assignments but not for a page or
  // folder someone labeled this way and added practice/review material to over the whole
  // semester. Let those through regardless of the chosen range; everything else still
  // respects it.
  if (isHomeworkContainerName(item.moduleContext) || isHomeworkContainerName(item.title)) return true;

  const dateStr = item.dueAt || item.updatedAt;
  // Undated items (bare module items with no due/updated date of their own, e.g. a module
  // link to an external URL) are dropped rather than passed through — otherwise every
  // compile would include items from the course's entire history regardless of the chosen
  // date range. Assignments and files still carry their own real dates and are unaffected.
  if (!dateStr) return false;
  const d = new Date(dateStr).getTime();
  return d >= startDate.getTime() && d <= endDate.getTime();
}

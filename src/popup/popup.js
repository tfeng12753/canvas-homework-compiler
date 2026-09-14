const el = (id) => document.getElementById(id);

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function showError(message) {
  el('errorBox').textContent = message;
  el('errorBox').hidden = false;
}

function clearError() {
  el('errorBox').hidden = true;
  el('errorBox').textContent = '';
}

function showCalError(message) {
  el('calErrorBox').textContent = message;
  el('calErrorBox').hidden = false;
}

function clearCalError() {
  el('calErrorBox').hidden = true;
  el('calErrorBox').textContent = '';
}

function switchTab(tab) {
  const showDoc = tab === 'doc';
  el('docPanel').hidden = !showDoc;
  el('calPanel').hidden = showDoc;
  el('tabDocBtn').classList.toggle('active', showDoc);
  el('tabCalBtn').classList.toggle('active', !showDoc);
}

async function init() {
  const settings = await chrome.storage.local.get(['canvasBaseUrl']);

  if (!settings.canvasBaseUrl) {
    el('setupNotice').hidden = false;
    el('tabs').hidden = true;
    el('docPanel').hidden = true;
    el('calPanel').hidden = true;
    el('setupLink').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }

  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  el('startDate').value = isoDate(monthAgo);
  el('endDate').value = isoDate(today);

  const in60Days = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
  el('calStartDate').value = isoDate(today);
  el('calEndDate').value = isoDate(in60Days);

  loadCourses();
  loadCanvasCoursesForCalendar();
}

function populateCourseList(listEl, courses, noneMessage) {
  if (courses.length === 0) {
    listEl.textContent = noneMessage;
    return;
  }
  listEl.innerHTML = '';
  for (const course of courses) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = course.id;
    checkbox.checked = true;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(course.name));
    listEl.appendChild(label);
  }
}

async function loadCourses() {
  const listEl = el('courseList');
  const res = await chrome.runtime.sendMessage({ type: 'LIST_COURSES' });
  if (!res.ok) {
    listEl.textContent = 'Could not load courses.';
    showError(res.error);
    return;
  }
  populateCourseList(listEl, res.courses, 'No active courses found.');
}

async function loadCanvasCoursesForCalendar() {
  const listEl = el('calCanvasCourseList');
  const res = await chrome.runtime.sendMessage({ type: 'LIST_COURSES' });
  if (!res.ok) {
    listEl.textContent = 'Could not load courses.';
    return;
  }
  populateCourseList(listEl, res.courses, 'No active courses found.');
}

async function loadGradescopeCourses() {
  const listEl = el('calGsCourseList');
  listEl.textContent = 'Loading…';
  const res = await chrome.runtime.sendMessage({ type: 'LIST_GRADESCOPE_COURSES' });
  if (!res.ok) {
    listEl.textContent = 'Could not load courses.';
    showCalError(res.error);
    return;
  }
  populateCourseList(listEl, res.courses, 'No Gradescope courses found.');
}

function getCheckedIds(listId) {
  return Array.from(el(listId).querySelectorAll('input[type=checkbox]:checked')).map((cb) => cb.value);
}

function setAllChecked(listId, checked) {
  el(listId)
    .querySelectorAll('input[type=checkbox]')
    .forEach((cb) => (cb.checked = checked));
}

let lastMarkdown = '';

function runCompile() {
  clearError();
  const courseIds = getCheckedIds('courseList').map(Number);
  if (courseIds.length === 0) {
    showError('Select at least one course.');
    return;
  }

  el('compileBtn').disabled = true;
  el('progress').hidden = false;
  el('results').hidden = true;
  el('progressText').textContent = 'Starting…';

  const ignoreDateRange = el('ignoreDateRange').checked;
  const includeSolutions = el('includeSolutions').checked;
  const flatQuestionList = el('flatQuestionList').checked;
  const generateSimilar = el('generateSimilar').checked;
  const forceUrls = el('forceUrls')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const port = chrome.runtime.connect({ name: 'compile' });
  port.postMessage({
    type: 'START',
    payload: {
      courseIds,
      ignoreDateRange,
      includeSolutions,
      flatQuestionList,
      generateSimilar,
      forceUrls,
      startDateISO: new Date(el('startDate').value).toISOString(),
      endDateISO: new Date(el('endDate').value + 'T23:59:59').toISOString(),
    },
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS') {
      el('progressText').textContent = msg.progress.message;
    } else if (msg.type === 'DONE') {
      el('compileBtn').disabled = false;
      el('progress').hidden = true;
      el('results').hidden = false;
      lastMarkdown = msg.result.markdown;
      el('preview').textContent = lastMarkdown.slice(0, 4000);
    } else if (msg.type === 'ERROR') {
      el('compileBtn').disabled = false;
      el('progress').hidden = true;
      showError(msg.error);
    }
  });
}

function downloadMarkdown() {
  const blob = new Blob([lastMarkdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'homework-practice.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportPdf() {
  chrome.runtime.sendMessage({ type: 'EXPORT_PDF', markdown: lastMarkdown });
}

function runCalendarSync() {
  clearCalError();
  const canvasCourseIds = getCheckedIds('calCanvasCourseList').map(Number);
  const gradescopeCourseIds = getCheckedIds('calGsCourseList');

  if (canvasCourseIds.length === 0 && gradescopeCourseIds.length === 0) {
    showCalError('Select at least one course (Canvas or Gradescope).');
    return;
  }

  el('syncBtn').disabled = true;
  el('calProgress').hidden = false;
  el('calResult').hidden = true;
  el('calProgressText').textContent = 'Starting…';

  const port = chrome.runtime.connect({ name: 'calendar-sync' });
  port.postMessage({
    type: 'START',
    payload: {
      canvasCourseIds,
      gradescopeCourseIds,
      startDateISO: new Date(el('calStartDate').value).toISOString(),
      endDateISO: new Date(el('calEndDate').value + 'T23:59:59').toISOString(),
    },
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS') {
      el('calProgressText').textContent = msg.progress.message;
    } else if (msg.type === 'DONE') {
      el('syncBtn').disabled = false;
      el('calProgress').hidden = true;
      el('calResult').hidden = false;
      el('calResultText').textContent =
        msg.result.total === 0
          ? 'No due dates found in this range.'
          : `Synced ${msg.result.synced}/${msg.result.total} due dates to your "Homework Compiler" Google Calendar.`;
    } else if (msg.type === 'ERROR') {
      el('syncBtn').disabled = false;
      el('calProgress').hidden = true;
      showCalError(msg.error);
    }
  });
}

el('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
el('tabDocBtn').addEventListener('click', () => switchTab('doc'));
el('tabCalBtn').addEventListener('click', () => switchTab('cal'));
el('compileBtn').addEventListener('click', runCompile);
el('downloadMd').addEventListener('click', downloadMarkdown);
el('exportPdf').addEventListener('click', exportPdf);
el('loadGsCoursesBtn').addEventListener('click', loadGradescopeCourses);
el('syncBtn').addEventListener('click', runCalendarSync);
el('ignoreDateRange').addEventListener('change', () => {
  const disabled = el('ignoreDateRange').checked;
  el('startDate').disabled = disabled;
  el('endDate').disabled = disabled;
});
document.querySelectorAll('[data-select-all]').forEach((btn) => {
  btn.addEventListener('click', () => setAllChecked(btn.dataset.selectAll, true));
});
document.querySelectorAll('[data-select-none]').forEach((btn) => {
  btn.addEventListener('click', () => setAllChecked(btn.dataset.selectNone, false));
});

init();

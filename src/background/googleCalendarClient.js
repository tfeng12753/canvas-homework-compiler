const API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_NAME = 'Homework Compiler';
const EVENT_DURATION_MS = 15 * 60 * 1000;

export function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const token = typeof result === 'string' ? result : result?.token;
      if (!token) {
        reject(new Error('Google sign-in did not return a token.'));
        return;
      }
      resolve(token);
    });
  });
}

export function clearCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

async function apiRequest(token, path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Google Calendar API ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function ensureHomeworkCalendar(token) {
  const cached = await chrome.storage.local.get('googleCalendarId');
  if (cached.googleCalendarId) {
    try {
      await apiRequest(token, `/calendars/${cached.googleCalendarId}`);
      return cached.googleCalendarId;
    } catch {
      // cached calendar no longer exists/accessible; fall through and re-resolve
    }
  }

  const list = await apiRequest(token, '/users/me/calendarList?maxResults=250');
  const existing = (list.items || []).find((c) => c.summary === CALENDAR_NAME);
  let calendarId;
  if (existing) {
    calendarId = existing.id;
  } else {
    const created = await apiRequest(token, '/calendars', {
      method: 'POST',
      body: JSON.stringify({
        summary: CALENDAR_NAME,
        description: 'Due dates synced from Canvas + Gradescope by the Homework Compiler extension.',
      }),
    });
    calendarId = created.id;
  }
  await chrome.storage.local.set({ googleCalendarId: calendarId });
  return calendarId;
}

export async function upsertEvent(token, calendarId, item) {
  const start = new Date(item.dueAt);
  const end = new Date(start.getTime() + EVENT_DURATION_MS);

  const eventBody = {
    summary: `${item.course.name}: ${item.title}`,
    description: `${item.url}\n\nSynced by Canvas Homework Compiler.`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: { private: { sourceId: item.id } },
  };

  const found = await apiRequest(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events?privateExtendedProperty=${encodeURIComponent(
      `sourceId=${item.id}`
    )}`
  );

  if (found.items && found.items.length > 0) {
    await apiRequest(token, `/calendars/${encodeURIComponent(calendarId)}/events/${found.items[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify(eventBody),
    });
    return 'updated';
  }

  await apiRequest(token, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(eventBody),
  });
  return 'created';
}

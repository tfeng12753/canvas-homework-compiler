const el = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const s = el('status');
  s.textContent = message;
  s.style.color = isError ? '#b02a2a' : '#2a7d2a';
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function load() {
  const s = await chrome.storage.local.get([
    'canvasBaseUrl',
    'canvasToken',
    'llmBaseUrl',
    'llmApiKey',
    'llmModel',
  ]);
  el('canvasBaseUrl').value = s.canvasBaseUrl || '';
  el('canvasToken').value = s.canvasToken || '';
  el('llmBaseUrl').value = s.llmBaseUrl || '';
  el('llmApiKey').value = s.llmApiKey || '';
  el('llmModel').value = s.llmModel || '';
}

async function grantAccess() {
  const origin = originOf(el('canvasBaseUrl').value);
  if (!origin) {
    setStatus('Enter a valid Canvas URL first.', true);
    return;
  }
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  setStatus(granted ? `Access granted for ${origin}` : 'Access was not granted.', !granted);
}

async function save() {
  const canvasBaseUrl = el('canvasBaseUrl').value.trim().replace(/\/+$/, '');
  const llmBaseUrl = el('llmBaseUrl').value.trim().replace(/\/+$/, '');
  const canvasOrigin = originOf(canvasBaseUrl);
  const llmOrigin = originOf(llmBaseUrl);

  const origins = [canvasOrigin, llmOrigin].filter(Boolean).map((o) => `${o}/*`);
  if (origins.length > 0) {
    await chrome.permissions.request({ origins });
  }

  await chrome.storage.local.set({
    canvasBaseUrl,
    canvasToken: el('canvasToken').value.trim(),
    llmBaseUrl,
    llmApiKey: el('llmApiKey').value.trim(),
    llmModel: el('llmModel').value.trim(),
  });
  setStatus('Settings saved.');
}

async function testCanvas() {
  setStatus('Testing Canvas connection…');
  await save();
  const res = await chrome.runtime.sendMessage({ type: 'TEST_CANVAS' });
  if (res.ok) {
    setStatus(`Connected via ${res.mode === 'api' ? 'API token' : 'browser session (fallback)'}.`);
  } else {
    setStatus(res.error, true);
  }
}

async function testLlm() {
  setStatus('Testing LLM connection…');
  const baseUrl = el('llmBaseUrl').value.trim().replace(/\/+$/, '');
  const apiKey = el('llmApiKey').value.trim();
  const model = el('llmModel').value.trim();
  const origin = originOf(baseUrl);
  if (origin) await chrome.permissions.request({ origins: [`${origin}/*`] });

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    setStatus(`LLM responded: ${data.choices?.[0]?.message?.content?.trim() || '(empty)'}`);
  } catch (err) {
    setStatus(`LLM test failed: ${err.message}`, true);
  }
}

async function grantGradescope() {
  const granted = await chrome.permissions.request({ origins: ['https://www.gradescope.com/*'] });
  setStatus(granted ? 'Access granted for Gradescope.' : 'Access was not granted.', !granted);
}

async function testGradescope() {
  setStatus('Testing Gradescope connection…');
  const res = await chrome.runtime.sendMessage({ type: 'TEST_GRADESCOPE' });
  setStatus(res.ok ? 'Connected to Gradescope.' : res.error, !res.ok);
}

async function connectGoogle() {
  setStatus('Connecting to Google Calendar…');
  const res = await chrome.runtime.sendMessage({ type: 'TEST_GOOGLE_CALENDAR' });
  setStatus(res.ok ? 'Connected — "Homework Compiler" calendar is ready.' : res.error, !res.ok);
}

el('grantAccess').addEventListener('click', grantAccess);
el('save').addEventListener('click', save);
el('testCanvas').addEventListener('click', testCanvas);
el('testLlm').addEventListener('click', testLlm);
el('grantGradescope').addEventListener('click', grantGradescope);
el('testGradescope').addEventListener('click', testGradescope);
el('connectGoogle').addEventListener('click', connectGoogle);

load();

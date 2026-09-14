function stripHtml(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function chatCompletion({ baseUrl, apiKey, model }, messages, { json = false, maxTokens } = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = { model, messages, temperature: 0 };
  if (json) body.response_format = { type: 'json_object' };
  // Explicit, generous max_tokens matters especially for "reasoning" models (their internal
  // reasoning eats into the token budget before the actual answer), which can otherwise
  // truncate the final JSON/answer before it's complete if a provider's default is small.
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON found in LLM response: ${cleaned.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

const CLASSIFY_BATCH_SIZE = 15;

export async function classifyItems(items, llmSettings, onProgress) {
  const results = [];
  for (let i = 0; i < items.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = items.slice(i, i + CLASSIFY_BATCH_SIZE);
    const payload = batch.map((it) => ({
      id: it.id,
      type: it.type,
      title: it.title,
      module: it.moduleContext,
      dueAt: it.dueAt,
      descriptionSnippet: stripHtml(it.descriptionHtml).slice(0, 400),
    }));

    const messages = [
      {
        role: 'system',
        content:
          'You classify Canvas LMS course items as practice material a student should work through to prepare for ' +
          'class or an exam, versus everything else (syllabi, announcements, rubrics, grading policies, general ' +
          'course pages, zoom links, attendance, navigation pages, etc). Practice material includes: homework ' +
          'problem sets, worksheets, exercises, assigned readings with questions to answer, AND practice tests/exams, ' +
          'sample exams, review sheets, study guides, and old exams with problems to work through. An item whose ' +
          '"module" field (its containing Canvas module or Files folder) is literally named something like ' +
          '"Homework", "HW", "Practice", "Practice Exam", "Review", or "Study Guide" is a strong signal it belongs, ' +
          'even if its own title is generic (e.g. "hw3.pdf" or "exam1_practice.pdf"). Respond with ONLY a JSON array, one object per input ' +
          'item, each shaped as {"id": string, "isHomework": boolean, "reason": string}. Preserve the input order and ids exactly.',
      },
      { role: 'user', content: JSON.stringify(payload) },
    ];

    try {
      const raw = await chatCompletion(llmSettings, messages, { json: false, maxTokens: 4000 });
      results.push(...extractJson(raw));
    } catch (err) {
      // One malformed batch response shouldn't take down the whole compile — the items in
      // this batch just won't be classified as homework (excluded), but every other batch,
      // and every other course, still goes through.
      console.error(`[Homework Compiler] Classification batch (items ${i}-${i + batch.length - 1}) failed:`, err);
    }
    onProgress?.(Math.min(i + CLASSIFY_BATCH_SIZE, items.length), items.length);
  }
  return results;
}

export async function extractQuestions(itemTitle, text, llmSettings) {
  const trimmed = text.slice(0, 12000);
  const messages = [
    {
      role: 'system',
      content:
        'You extract the actual practice questions/problems from a piece of homework or practice-test/exam material ' +
        'for a student to re-practice later. ' +
        'Ignore instructions, point values, rubrics, due dates, formatting boilerplate, and answer keys. ' +
        'Return the questions as a clean Markdown numbered list, preserving sub-parts (a, b, c) where present. ' +
        'If the text contains no extractable questions, return exactly: NONE_FOUND.',
    },
    {
      role: 'user',
      content: `Source: "${itemTitle}"\n\n${trimmed}`,
    },
  ];
  const raw = await chatCompletion(llmSettings, messages, { json: false, maxTokens: 4000 });
  return raw.trim();
}

export async function findRelevantLinks(links, llmSettings) {
  if (links.length === 0) return [];

  const payload = links.map((l, index) => ({ index, text: l.text, href: l.href }));
  const messages = [
    {
      role: 'system',
      content:
        'These are links found on a Canvas course homepage. Identify which ones likely lead to homework/practice ' +
        'material for students (problem sets, worksheets, practice exercises, a page or folder of assigned work, ' +
        'practice tests/exams, review sheets, study guides) — there is no fixed naming convention across courses, so ' +
        'use judgment based on the link text and URL path (e.g. "Homework", "HW", "Practice Problems", "Coursework", ' +
        '"Practice Exams", "Review", or something else implied by context). Do not ' +
        'select links to a syllabus, zoom/meeting links, grading policy, staff/office-hours pages, or general ' +
        'announcements. Respond with ONLY a JSON array of the matching indices, e.g. [0, 3]. If none look relevant, ' +
        'respond with [].',
    },
    { role: 'user', content: JSON.stringify(payload) },
  ];

  const raw = await chatCompletion(llmSettings, messages, { json: false, maxTokens: 1000 });
  const indices = extractJson(raw);
  return indices.map((i) => links[i]).filter(Boolean);
}

export async function generateSimilarProblems(itemTitle, sourceText, llmSettings) {
  const trimmed = sourceText.slice(0, 8000);
  const messages = [
    {
      role: 'system',
      content:
        'You write NEW practice problems that are similar in topic, style, and difficulty to the given homework or ' +
        'practice-test material, for a student who wants extra practice beyond the original. Do not just reword the ' +
        'originals — write genuinely new problems (different numbers, scenarios, or specifics) that exercise the same ' +
        'concepts and skills. Generate roughly as many new problems as there are original questions (use judgment for ' +
        'very short or very long sets). Return ONLY the new problems as a clean Markdown numbered list, with no ' +
        'commentary, preamble, or reference back to the originals. If the source has no clear problems to base new ' +
        'ones on, return exactly: NONE_FOUND.',
    },
    { role: 'user', content: `Source: "${itemTitle}"\n\n${trimmed}` },
  ];
  const raw = await chatCompletion(llmSettings, messages, { json: false, maxTokens: 4000 });
  return raw.trim();
}

export { stripHtml };

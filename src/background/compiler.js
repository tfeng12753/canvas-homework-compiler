function similarProblemsLines(item) {
  if (!item.similarProblems || item.similarProblems === 'NONE_FOUND') return [];
  return [
    '',
    "**AI-Generated Similar Practice Problems** _(not from the original source material — generated for extra practice)_",
    '',
    item.similarProblems,
  ];
}

function formatDate(dateStr) {
  if (!dateStr) return 'No due date';
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function compileMarkdown(items, { startDate, endDate, ignoreDateRange }) {
  const byCourse = new Map();
  for (const item of items) {
    const key = item.course.name;
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key).push(item);
  }

  const lines = [];
  lines.push('# Homework Practice Compilation');
  lines.push('');
  lines.push(
    ignoreDateRange
      ? 'Range: All dates  '
      : `Range: ${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}  `
  );
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push('');

  for (const [courseName, courseItems] of byCourse) {
    lines.push(`## ${courseName}`);
    lines.push('');
    courseItems.sort((a, b) => new Date(a.dueAt || 0) - new Date(b.dueAt || 0));
    for (const item of courseItems) {
      lines.push(`### ${item.title}${item.isSolution ? ' (Solutions)' : ''}`);
      lines.push(`*Due: ${formatDate(item.dueAt)} · [Open in Canvas](${item.url})*`);
      lines.push('');
      if (item.extractedQuestions && item.extractedQuestions !== 'NONE_FOUND') {
        lines.push(item.extractedQuestions);
      } else if (item.fallbackText) {
        lines.push(item.fallbackText);
      } else {
        lines.push('_No extractable question text found — see Canvas link above._');
      }
      lines.push(...similarProblemsLines(item));
      lines.push('');
    }
  }

  return lines.join('\n');
}

// A pure "practice worksheet" view: every extracted question from every selected course,
// one after another, with just a lightweight source line instead of the full due-date/link
// header block — meant for printing or reading straight through, not for navigating back
// to Canvas.
export function compileFlatQuestionList(items) {
  const lines = [];
  lines.push('# All Practice Questions');
  lines.push('');
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push('');

  const withContent = items.filter(
    (item) =>
      (item.extractedQuestions && item.extractedQuestions !== 'NONE_FOUND') || item.fallbackText
  );

  if (withContent.length === 0) {
    lines.push('_No extractable question text found in any selected item._');
    return lines.join('\n');
  }

  for (const item of withContent) {
    const text =
      item.extractedQuestions && item.extractedQuestions !== 'NONE_FOUND'
        ? item.extractedQuestions
        : item.fallbackText;
    lines.push(`**${item.course.name} — ${item.title}${item.isSolution ? ' (Solutions)' : ''}**`);
    lines.push('');
    lines.push(text);
    lines.push(...similarProblemsLines(item));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export function markdownToPrintableHtml(markdown, title) {
  // Minimal markdown -> HTML for the print/PDF view (headings, lists, links, bold, line breaks).
  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const htmlLines = markdown.split('\n').map((line) => {
    if (line.trim() === '---') return '<hr/>';
    if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
    if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
    if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
    let l = escapeHtml(line);
    l = l.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    l = l.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    l = l.replace(/\*([^*]+)\*/g, '<i>$1</i>');
    return l ? `<p>${l}</p>` : '<br/>';
  });

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 800px; margin: 2rem auto; line-height: 1.5; color: #1a1a1a; }
    h1 { border-bottom: 2px solid #333; padding-bottom: .3rem; }
    h2 { margin-top: 2rem; color: #2b4a7d; }
    h3 { margin-top: 1.2rem; }
    a { color: #2b4a7d; }
    @media print { body { margin: 0; } }
  </style></head><body>${htmlLines.join('\n')}</body></html>`;
}

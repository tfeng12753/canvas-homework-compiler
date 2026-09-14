import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';

// Service workers can't easily spawn the pdf.js worker as a separate script,
// so text extraction (no rendering needed) runs disableWorker on the main thread.
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

async function extractPdfText(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, disableWorker: true });
  const doc = await loadingTask.promise;
  const pageTexts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((it) => it.str).join(' '));
  }
  return pageTexts.join('\n');
}

async function extractDocxText(arrayBuffer) {
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  return value;
}

export async function extractTextFromAttachment(attachment, arrayBuffer) {
  const name = attachment.name.toLowerCase();
  try {
    if (name.endsWith('.pdf')) return await extractPdfText(arrayBuffer);
    if (name.endsWith('.docx')) return await extractDocxText(arrayBuffer);
    return null; // unsupported type (e.g. legacy .doc)
  } catch (err) {
    console.warn(`Failed to extract text from ${attachment.name}:`, err);
    return null;
  }
}

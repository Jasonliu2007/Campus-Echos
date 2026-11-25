'use strict';
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFNumber, PDFRef, PDFRawStream, StandardFonts, rgb, degrees } = require('pdf-lib');
const { createHash } = require('crypto');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_OBJECTS = 100000;
const MAX_PAGES = 200;
function reject(code) { const error = new Error(code); error.code = code; throw error; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

// This is a conservative supported-structure check in an isolated, bounded worker.
// It is not an antivirus or a guarantee that arbitrary PDF content is harmless.
async function loadSupported(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) reject('PDF_SIZE_LIMIT');
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') reject('PDF_FORMAT_UNSUPPORTED');
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false, capNumbers: true });
    doc.getPageCount(); doc.context.enumerateIndirectObjects();
  }
  catch (_) { reject('PDF_PARSE_OR_ENCRYPTION_REJECTED'); }
  if (doc.isEncrypted) reject('PDF_ENCRYPTED');
  if (doc.getPageCount() < 1 || doc.getPageCount() > MAX_PAGES) reject('PDF_PAGE_LIMIT');
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    if (![width, height].every(n => Number.isFinite(n) && n >= 10 && n <= 20000)) reject('PDF_PAGE_DIMENSION_LIMIT');
  }
  const objects = doc.context.enumerateIndirectObjects();
  if (objects.length > MAX_OBJECTS) reject('PDF_STRUCTURE_LIMIT');
  const prohibitedKeys = new Set(['JS', 'JavaScript', 'AA', 'OpenAction', 'EmbeddedFiles', 'EF', 'AF', 'XFA', 'RichMediaContent', 'RichMediaSettings', 'Collection']);
  const prohibitedTypes = new Set(['JavaScript', 'Launch', 'EmbeddedFile', 'Filespec', 'RichMedia', 'Movie', 'Sound', 'GoToR', 'SubmitForm', 'ImportData']);
  const seen = new Set();
  function walk(object, depth = 0) {
    if (!object || depth > 80) { if (depth > 80) reject('PDF_STRUCTURE_LIMIT'); return; }
    if (object instanceof PDFRef) return;
    if (typeof object !== 'object' || seen.has(object)) return;
    seen.add(object);
    if (object instanceof PDFRawStream) { walk(object.dict, depth + 1); return; }
    if (object instanceof PDFName && prohibitedTypes.has(object.decodeText())) reject('PDF_ACTIVE_CONTENT_REJECTED');
    if (object instanceof PDFDict) {
      for (const [name, value] of object.entries()) {
        if (prohibitedKeys.has(name.decodeText())) reject('PDF_ACTIVE_CONTENT_REJECTED');
        walk(value, depth + 1);
      }
    } else if (object instanceof PDFArray) for (let i = 0; i < object.size(); i += 1) walk(object.get(i), depth + 1);
  }
  for (const [, object] of objects) walk(object);
  return doc;
}

function suggestedCatalog(doc) {
  const result = [], pageRefs = new Map(doc.getPages().map((page, i) => [page.ref.toString(), i + 1]));
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const dests = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  function resolveDestination(value) {
    if (value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName) {
      const name = value instanceof PDFName ? value.decodeText() : value.decodeText();
      if (dests) value = dests.get(PDFName.of(name));
      else if (names) {
        const named = names.lookupMaybe(PDFName.of('Dests'), PDFDict);
        const array = named && named.lookupMaybe(PDFName.of('Names'), PDFArray);
        if (array) for (let i = 0; i + 1 < array.size(); i += 2) { const candidate = array.lookup(i); if ((candidate instanceof PDFString || candidate instanceof PDFHexString) && candidate.decodeText() === name) { value = array.get(i + 1); break; } }
      }
    }
    value = doc.context.lookup(value);
    if (value instanceof PDFDict) value = value.lookupMaybe(PDFName.of('D'), PDFArray);
    if (!(value instanceof PDFArray) || !value.size()) return null;
    const first = value.get(0);
    if (first instanceof PDFRef) return pageRefs.get(first.toString()) || null;
    if (first instanceof PDFNumber) { const number = first.asNumber() + 1; return number >= 1 && number <= doc.getPageCount() ? number : null; }
    return null;
  }
  const visited = new Set();
  function visit(ref, depth) {
    if (!ref || depth > 12 || result.length >= 80) return;
    const identity = ref.toString(); if (visited.has(identity)) return; visited.add(identity);
    const node = doc.context.lookup(ref); if (!(node instanceof PDFDict)) return;
    const title = node.lookup(PDFName.of('Title'));
    let destination = node.get(PDFName.of('Dest'));
    const action = node.lookupMaybe(PDFName.of('A'), PDFDict);
    if (!destination && action && action.get(PDFName.of('S')) === PDFName.of('GoTo')) destination = action.get(PDFName.of('D'));
    const page = resolveDestination(destination);
    if ((title instanceof PDFString || title instanceof PDFHexString) && page) {
      const text = Array.from(title.decodeText().replace(/[\u0000-\u001f]/g, '').trim()).slice(0, 80).join('');
      if (text) result.push({ title: text, page });
    }
    visit(node.get(PDFName.of('First')), depth + 1); visit(node.get(PDFName.of('Next')), depth);
  }
  const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  if (outlines) visit(outlines.get(PDFName.of('First')), 0);
  return result;
}

async function rebuild(doc, indices) {
  const clean = await PDFDocument.create();
  for (const index of indices) {
    const page = doc.getPage(index);
    // Blank pages legitimately omit Contents. Give the embedder an empty
    // stream so mixed documents and blank chosen preview pages remain valid.
    if (!page.node.Contents()) page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('')));
  }
  const embedded = await clean.embedPages(indices.map(i => doc.getPage(i)));
  embedded.forEach(page => {
    const output = clean.addPage([page.width, page.height]); output.drawPage(page);
  });
  clean.setProducer('Campus Echo PDF processor');
  return clean;
}
async function processTask(task, bytes) {
  const doc = await loadSupported(bytes);
  if (task.type === 'inspect') return { pageCount: doc.getPageCount(), sha256: sha256(bytes), suggestedCatalog: suggestedCatalog(doc), limitations: 'supported-structure-check; not malware certification' };
  if (task.expectedHash && task.expectedHash !== sha256(bytes)) reject('SOURCE_HASH_MISMATCH');
  if (task.type === 'preview') {
    if (!Array.isArray(task.pages) || task.pages.length < 1 || task.pages.length > 2 || new Set(task.pages).size !== task.pages.length || task.pages.some(p => !Number.isInteger(p) || p < 1 || p > doc.getPageCount())) reject('PREVIEW_PAGES_INVALID');
    const clean = await rebuild(doc, task.pages.map(p => p - 1));
    return { bytes: Buffer.from(await clean.save({ useObjectStreams: true })), pageCount: task.pages.length };
  }
  if (task.type === 'watermark') {
    if (typeof task.alias !== 'string' || !/^Reader-[a-f0-9]{10}$/.test(task.alias) || typeof task.shortId !== 'string' || !/^[A-F0-9]{8}$/.test(task.shortId)) reject('WATERMARK_ID_INVALID');
    const clean = await rebuild(doc, doc.getPageIndices()), font = await clean.embedFont(StandardFonts.Helvetica);
    const label = `CAMPUS ECHO / ${task.alias} / ${task.shortId}`;
    clean.getPages().forEach(page => {
      const { width, height } = page.getSize(), size = Math.max(10, Math.min(16, width / 36));
      for (let y = 55; y < height; y += 145) for (let x = -10; x < width; x += Math.max(260, width * 0.62)) page.drawText(label, { x, y, size, font, opacity: 0.17, color: rgb(0.18, 0.29, 0.39), rotate: degrees(28) });
    });
    return { bytes: Buffer.from(await clean.save({ useObjectStreams: true })), pageCount: clean.getPageCount() };
  }
  reject('PDF_TASK_INVALID');
}
module.exports = { processTask, loadSupported, suggestedCatalog, sha256, MAX_BYTES, MAX_PAGES };

// Keywords are rendered as ordinary text segments. Never generate HTML.
function segments(value, words) {
  const text = String(value || '');
  const terms = [...new Set((words || []).map(x => String(x).toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase(), ranges = [];
  let at = 0;
  while (at < text.length) {
    const term = terms.find(word => lower.startsWith(word, at));
    if (term) { ranges.push({ text: text.slice(at, at + term.length), hit: true }); at += term.length; }
    else { let end = at + 1; while (end < text.length && !terms.some(word => lower.startsWith(word, end))) end += 1; ranges.push({ text: text.slice(at, end), hit: false }); at = end; }
  }
  return ranges;
}
module.exports = { segments };

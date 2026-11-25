// Publishing remains plain text. These helpers never parse or emit HTML.
const symbols = ['•', '◦', '—', '→', '✓', '□', '①', '②'];
const templates = {
  '校园生活墙': '【想分享的事】\n\n【时间与地点】\n\n【补充说明】\n',
  '表白墙': '【想说的话】\n\n【印象深刻的瞬间】\n\n【希望传达的心意】\n',
  'AI论坛墙': '【使用场景】\n\n【已核验的方法】\n\n【想讨论的问题】\n',
  '申研实习墙': '【申请或实习方向】\n\n【准备与经历】\n\n【想交流的问题】\n',
  experience: '【真实经历】\n\n【准备过程】\n\n【踩过的坑】\n\n【给同学的建议】\n'
};

function safeCursor(text, cursor) {
  let at = Number.isInteger(cursor) && cursor >= 0 ? Math.min(cursor, text.length) : text.length;
  // Native cursor offsets use UTF-16; never split an emoji surrogate pair.
  if (at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at])) at += 1;
  return at;
}

function insertText(text, insertion, cursor) {
  const at = safeCursor(text, cursor);
  const content = text.slice(0, at) + insertion + text.slice(at);
  if (Array.from(content).length > 2000) return { error: '插入后会超过2000字，请先缩短正文。原文已保留。' };
  return { content, cursor: at + insertion.length, contentCount: Array.from(content).length };
}

function blocks(content) {
  return String(content || '').split('\n').map((line, index) => ({
    id: index,
    kind: /^【[^\n]{1,60}】$/.test(line.trim()) ? 'heading' : /^[—─-]{3,}$/.test(line.trim()) ? 'divider' : line.trim() ? 'paragraph' : 'space',
    text: line
  }));
}

module.exports = { symbols, templates, safeCursor, insertText, blocks };

'use strict';
const { createHash } = require('crypto');
const CATEGORIES = ['校园生活墙', '表白墙', 'AI论坛墙', '申研实习墙'];
const LEGACY = ['失物招领', '吐槽树洞', '学习互助', '闲置转让', '生活墙', '学长学姐经验分享墙'];
const TOKENIZER_VERSION = 'zh-intl-nfkc-v1';
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim();
function category(value) { return CATEGORIES.includes(value) ? value : '校园生活墙'; }
function tokenize(value) {
  if (typeof Intl.Segmenter !== 'function') { const error = new Error('云环境暂不支持中文分词。'); error.code = 'SEARCH_UNAVAILABLE'; throw error; }
  return [...new Set([...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(normalize(value))].filter(x => x.isWordLike).map(x => x.segment))];
}
function fields(post) { return { title: normalize(post.title), content: normalize(post.content), version: TOKENIZER_VERSION }; }
function score(post, phrase, words) {
  const f = fields(post);
  return (f.title.includes(phrase) ? 16 : 0) + words.filter(x => f.title.includes(x)).length * 4 + (f.content.includes(phrase) ? 4 : 0) + words.filter(x => f.content.includes(x)).length;
}
function excerpt(content, query, max = 60) {
  const chars = Array.from(String(content || ''));
  const at = normalize(content).indexOf(query);
  const start = Math.max(0, at > 15 ? Array.from(normalize(content).slice(0, at)).length - 15 : 0);
  return chars.slice(start, start + max).join('');
}
function fingerprint(rows) { return createHash('sha256').update(rows.map(p => [p._id, p.revision, p.status, p.category, p.title, p.content].join(':')).sort().join('\n')).digest('hex'); }
module.exports = { CATEGORIES, LEGACY, TOKENIZER_VERSION, normalize, category, tokenize, fields, score, excerpt, fingerprint };

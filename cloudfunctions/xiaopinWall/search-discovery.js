'use strict';

const search = require('./search-core');
const DAY = 86400000;
const ZONE_OFFSET = 8 * 3600000;
const TOPICS = [
  ['期末复习', /期末|复习|备考/], ['图书馆', /图书馆/], ['自习', /自习/],
  ['课程笔记', /课程笔记|课堂笔记/], ['实习', /实习/], ['申研', /申研|考研|保研/],
  ['简历', /简历/], ['AI', /\bai\b/i], ['找搭子', /搭子|组队/],
  ['校园活动', /校园活动|社团活动/], ['比赛', /比赛|竞赛/], ['失物招领', /失物|招领/]
];

function topicPattern(query) {
  return TOPICS.find(([label]) => search.normalize(label) === query)?.[1];
}

function engagement(post) {
  return Math.min(100, Math.max(0, post.likeCount || 0))
    + Math.min(100, Math.max(0, post.commentCount || 0)) * 2;
}

function startOfToday(clock) {
  return Math.floor((clock + ZONE_OFFSET) / DAY) * DAY - ZONE_OFFSET;
}

async function discover(event, member, { repo, now, community, active, publicPost, isPublicSafe }) {
  active(member);
  const space = community(event.community);
  const clock = now();
  const midnight = startOfToday(clock);
  const cutoff = clock - 7 * DAY;
  const candidates = [];
  let cursor = null;
  for (let batchIndex = 0; batchIndex < 5; batchIndex += 1) {
    const batch = await repo.query('posts', { where: { kind: 'post', status: 'published' }, cursor, limit: 50 });
    const recent = batch.filter(post => post.createdAt >= cutoff && post.createdAt <= clock && (post.community || 'forum') === space);
    const checked = await Promise.all(recent.map(async post => (await isPublicSafe(post)) ? post : null));
    candidates.push(...checked.filter(Boolean));
    const last = batch[batch.length - 1];
    if (batch.length < 50 || last.createdAt < cutoff) break;
    cursor = { createdAt: last.createdAt, _id: last._id };
  }

  const trends = TOPICS.map(([query, pattern]) => {
    const posts = candidates.filter(post => post.createdAt >= midnight && pattern.test(search.normalize(post.title || '')));
    return { query, count: posts.length, score: posts.reduce((sum, post) => sum + 2 + engagement(post), 0) };
  }).filter(topic => topic.count > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, 5).map(({ query, count }) => ({ query, count }));

  const recommendations = candidates.sort((a, b) => engagement(b) - engagement(a) || b.createdAt - a.createdAt)
    .slice(0, 24)
    .map(post => {
      const { content, ...summary } = publicPost(post, member);
      return { ...summary, discoveryExcerpt: Array.from(content || '').slice(0, 120).join('') };
    });
  return { trends, recommendations };
}

module.exports = { discover, startOfToday, topicPattern };

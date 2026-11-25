'use strict';
const { DIRECT_MAX_BYTES } = require('./media');

function createDirectMessages({ repo, hash, id, text, fail, approved, moderation, active, isPublicSafe, isSamplePost, media, storage, now }) {
  function threadKey(a, b) {
    return hash(['direct', ...[a, b].sort()].join(':'));
  }

  function participant(thread, ownId) {
    if (!thread || ![thread.sender, thread.recipient].includes(ownId)) fail('NOT_FOUND', '会话不可用。');
    return thread.sender === ownId ? thread.recipient : thread.sender;
  }

  function summary(thread, ownId) {
    const peerId = participant(thread, ownId);
    return { id: thread._id, peerId, name: thread.names[peerId], status: thread.status,
      incoming: thread.recipient === ownId, last: thread.last, updatedAt: thread.createdAt,
      unread: thread.lastBy !== ownId && !(thread.read || {})[ownId] };
  }

  function maySend(row, actor) {
    return !row || row.status === 'accepted' || (row.status === 'pending' && row.recipient === actor);
  }

  async function tradeContext(source, event, ownId) {
    if (event.orderId) {
      const order = await source.get('orders', id(event.orderId, '订单'));
      if (!order || order.kind !== 'order' || ![order.buyerId, order.sellerId].includes(ownId)) fail('NOT_FOUND', '订单不可用。');
      return {
        peerId: order.buyerId === ownId ? order.sellerId : order.buyerId,
        id: order._id, materialId: order.materialId, title: order.title, type: 'order'
      };
    }
    if (event.materialId) {
      const material = await source.get('materials', id(event.materialId, '资料'));
      if (!material || material.kind !== 'material' || material.status !== 'published') fail('NOT_FOUND', '资料不可用。');
      return { peerId: material.sellerId, id: material._id, materialId: material._id, title: material.title, type: 'material' };
    }
    return null;
  }

  function displayContext(trade) {
    return trade ? { id: trade.id, materialId: trade.materialId, title: trade.title, type: trade.type } : null;
  }

  async function handle(event, member, openid) {
    active(member);
    const ownId = member._id;
    if (event.action === 'directFindMember') {
      const nickname = text(event.nickname, 16, '用户名', 2);
      const users = await repo.findDirectMembers(nickname);
      return { users: users.filter(row => row._id !== ownId && !row.banned)
        .map(row => ({ id: row._id, name: row.nickname })) };
    }
    if (event.action === 'directList') {
      const [sent, received] = await Promise.all(['sender', 'recipient'].map(field =>
        repo.query('directThreads', { where: { [field]: ownId }, limit: 40 })));
      return { threads: sent.concat(received).filter(row => row.status !== 'blocked' && row.status !== 'declined')
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 60).map(row => summary(row, ownId)) };
    }

    const trade = await tradeContext(repo, event, ownId);
    let peerId;
    if (trade && !event.threadId) peerId = trade.peerId;
    else if (event.peerId && !event.threadId && !event.postId) peerId = id(event.peerId, '用户');
    else if (event.postId) {
      const post = await repo.get('posts', id(event.postId));
      if (!post || post.status !== 'published' || post.isAnonymous || isSamplePost(post) || !(await isPublicSafe(post))) fail('NOT_FOUND', '此帖子无法发起私信。');
      peerId = post.authorId;
    } else {
      const thread = await repo.get('directThreads', id(event.threadId, '会话'));
      peerId = participant(thread, ownId);
    }
    if (trade && trade.peerId !== peerId) {
      // A seller replying in an existing material conversation is also a party.
      const materialSellerReply = trade.type === 'material' && trade.peerId === ownId && !!event.threadId &&
        (await repo.get('directThreads', id(event.threadId, '会话')))?.trade?.materialId === trade.materialId;
      if (!materialSellerReply) fail('NOT_FOUND', '此交易与会话不匹配。');
    }
    if (peerId === ownId) fail('INVALID_INPUT', '不能给自己发私信。');
    const threadId = threadKey(ownId, peerId);
    const peer = approved(await repo.get('members', peerId));
    if (peer.banned) fail('ACCESS_DENIED', '该账号暂不可联系。');

    if (event.action === 'directUpload') {
      active(member, true);
      const row = await repo.get('directThreads', threadId);
      if (!maySend(row, ownId)) fail('ACCESS_DENIED', '收到回复后可以继续发送。');
      return media.uploadMedia(event, openid, ownId, threadId);
    }

    if (event.action === 'directAttachment') {
      const read = async () => {
        const row = await repo.get('directThreads', threadId);
        participant(row, ownId);
        if (!['accepted', 'pending'].includes(row.status)) fail('ACCESS_DENIED', '会话已关闭。');
        const message = await repo.get('directMessages', id(event.messageId, '消息'));
        if (!message?.attachmentId || message.threadId !== threadId) fail('NOT_FOUND', '图片不可用。');
        const asset = await repo.get('media', message.attachmentId);
        if (asset?.status !== 'approved' || asset.directThreadId !== threadId || asset.directMessageId !== message._id || !asset.fileId) fail('NOT_FOUND', '图片不可用。');
        active(approved(await repo.get('members', ownId)));
        if (approved(await repo.get('members', peerId)).banned) fail('ACCESS_DENIED', '会话已关闭。');
        return asset.fileId;
      };
      if (!storage) fail('MEDIA_UNAVAILABLE', '图片暂不可用。');
      const fileId = await read();
      const url = await storage.url(fileId, 120);
      if (await read() !== fileId) fail('CONFLICT', '图片已更新。');
      return { url };
    }

    if (event.action === 'directOpen') {
      const thread = await repo.transaction(async tx => {
        const row = await tx.get('directThreads', threadId);
        if (!row) return null;
        participant(row, ownId);
        if (row.status === 'blocked' || row.status === 'declined') fail('ACCESS_DENIED', '此会话已关闭。');
        if (!(row.read || {})[ownId]) await tx.set('directThreads', threadId, { ...row, read: { ...row.read, [ownId]: true } });
        return row;
      });
      const rows = thread ? await repo.query('directMessages', { where: { threadId }, limit: 50 }) : [];
      return { thread: thread ? summary(thread, ownId) : { id: threadId, name: peer.nickname, status: 'new' },
        trade: displayContext(trade) || thread?.trade || null,
        messages: rows.reverse().map(row => ({ id: row._id, content: row.content, mine: row.authorId === ownId,
          hasAttachment: !!row.attachmentId, quote: row.quote || null })) };
    }

    if (event.action === 'directRespond') {
      if (event.status === 'accepted') fail('FORBIDDEN', '回复一条消息即可开始对话。');
      if (!['declined', 'blocked'].includes(event.status)) fail('INVALID_INPUT', '请选择会话操作。');
      return repo.transaction(async tx => {
        approved(await tx.get('members', ownId));
        const row = await tx.get('directThreads', threadId);
        participant(row, ownId);
        if (event.status !== 'blocked' && (row.recipient !== ownId || row.status !== 'pending')) {
          fail('FORBIDDEN', '只有收件人可以处理待接受请求。');
        }
        await tx.set('directThreads', threadId, { ...row, status: event.status });
        return { status: event.status };
      });
    }

    active(member, true);
    const quoteCents = event.quoteCents;
    if (quoteCents !== undefined && (!trade || !Number.isSafeInteger(quoteCents) || quoteCents < 0 || quoteCents > 10000000)) {
      fail('INVALID_INPUT', '请填写有效报价。');
    }
    const matchesQuote = prior => quoteCents === undefined ? !prior.quote
      : prior.quote?.cents === quoteCents && prior.quote.id === trade.id && prior.quote.type === trade.type;
    const attachmentId = event.attachmentId ? id(event.attachmentId, '图片') : '';
    const empty = event.content === undefined || (typeof event.content === 'string' && !event.content.trim());
    const content = (attachmentId || quoteCents !== undefined) && empty ? '' : text(event.content, 500, '私信');
    if (typeof event.requestId !== 'string' || !/^[a-z0-9-]{10,64}$/.test(event.requestId)) fail('INVALID_INPUT', '私信请求无效。');
    const messageId = hash([threadId, ownId, event.requestId].join(':'));
    const duplicate = await repo.get('directMessages', messageId);
    if (duplicate?.content === content && (duplicate.attachmentId || '') === attachmentId && matchesQuote(duplicate)) return { id: messageId, threadId };
    if (duplicate) fail('CONFLICT', '这条消息已发送。');
    if (content && (await moderation(openid, content)).suggestion !== 'pass') fail('CONTENT_REJECTED', '这条私信未通过审核，请修改后再试。');

    return repo.transaction(async tx => {
      const actor = active(await tx.get('members', ownId), true);
      const currentPeer = approved(await tx.get('members', peerId));
      if (currentPeer.banned) fail('ACCESS_DENIED', '该账号暂不可联系。');
      const existing = await tx.get('directMessages', messageId);
      if (existing?.content === content && (existing.attachmentId || '') === attachmentId && matchesQuote(existing)) return { id: messageId, threadId };
      if (existing) fail('CONFLICT', '这条消息已发送。');
      const row = await tx.get('directThreads', threadId);
      if (!maySend(row, ownId)) fail('ACCESS_DENIED', '收到回复后可以继续发送。');
      let quote;
      if (quoteCents !== undefined) {
        const current = await tradeContext(tx, event, ownId);
        if (!current || current.peerId !== trade.peerId || current.id !== trade.id || current.type !== trade.type) fail('CONFLICT', '资料或订单已更新。');
        // Only a buyer may start a material chat. The seller can quote in a
        // conversation where this buyer has already contacted them about it.
        if (current.type === 'material' && current.peerId === ownId && row?.trade?.materialId !== current.materialId) {
          fail('NOT_FOUND', '此资料与会话不匹配。');
        }
        quote = { ...displayContext(current), cents: quoteCents };
      }
      const createdAt = now();
      if (attachmentId) {
        const asset = await tx.get('media', attachmentId);
        if (asset?.ownerId !== ownId || asset.directThreadId !== threadId || asset.directMessageId || asset.status !== 'approved' ||
          !asset.fileId || !asset.traceId || !asset.sha256 || asset.moderationVersion !== 1 || !(asset.bytes > 0 && asset.bytes <= DIRECT_MAX_BYTES)) {
          fail('MEDIA_NOT_APPROVED', '请等图片审核通过。');
        }
        await tx.set('media', attachmentId, { ...asset, directMessageId: messageId, gcCandidateAt: null });
      }
      await tx.set('directMessages', messageId, { threadId, authorId: ownId, content, ...(attachmentId ? { attachmentId } : {}), ...(quote ? { quote } : {}), createdAt });
      await tx.set('directThreads', threadId, {
        ...(row || { sender: ownId, recipient: peerId, status: 'pending' }),
        ...(row?.status === 'pending' ? { status: 'accepted' } : {}),
        ...(trade ? { trade: displayContext(trade) } : {}),
        names: { [ownId]: actor.nickname, [peerId]: currentPeer.nickname },
        last: quote ? '[报价]' : content || '[图片]', lastBy: ownId, read: { [ownId]: true, [peerId]: false }, createdAt,
      });
      return { id: messageId, threadId };
    });
  }
  return { handle };
}

module.exports = { createDirectMessages };

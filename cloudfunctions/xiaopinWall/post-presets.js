'use strict';

function readPresets(event, fail) {
  const { avatarId, coverId, stickerId, replyScope, reviewReplies, poll, location, hideTitle } = event;
  if (avatarId !== undefined && avatarId !== '' && (typeof avatarId !== 'string' || !/^avatar-[1-8]$/.test(avatarId))) {
    fail('INVALID_INPUT', '请选择内置头像。');
  }
  if (coverId !== undefined && coverId !== '' && (typeof coverId !== 'string' || !/^cover-[1-6]$/.test(coverId))) {
    fail('INVALID_INPUT', '请选择内置配图。');
  }
  if (stickerId !== undefined && (!Number.isInteger(stickerId) || stickerId < 0 || stickerId > 30)) fail('INVALID_INPUT', '请选择内置贴纸。');
  if (replyScope !== undefined && !['members', 'author'].includes(replyScope)) fail('INVALID_INPUT', '回复范围无效。');
  if (reviewReplies !== undefined && typeof reviewReplies !== 'boolean') fail('INVALID_INPUT', '回复审批设置无效。');
  if (location !== undefined && (typeof location !== 'string' || Array.from(location).length > 40 || /[\r\n]/.test(location))) fail('INVALID_INPUT', '地点名称最多40字。');
  if (poll !== undefined && poll !== null && (!Array.isArray(poll) || poll.length < 2 || poll.length > 4 ||
    poll.some(value => typeof value !== 'string' || !value.trim() || value !== value.trim() || Array.from(value).length > 40 || /[\r\n]/.test(value)) ||
    new Set(poll).size !== poll.length)) fail('INVALID_INPUT', '投票需要2到4个不同的选项。');
  if (hideTitle !== undefined && typeof hideTitle !== 'boolean') fail('INVALID_INPUT', '标题设置无效。');
  return {
    ...(hideTitle === undefined ? {} : { hideTitle }),
    ...(avatarId === undefined ? {} : { avatarId }),
    ...(poll === undefined ? {} : { poll }),
    ...(location === undefined ? {} : { location: location.trim() }),
    ...(stickerId === undefined ? {} : { stickerId }),
    ...(replyScope === undefined ? {} : { replyScope }),
    ...(reviewReplies === undefined ? {} : { reviewReplies }),
    ...(coverId === undefined ? {} : { coverId })
  };
}

function checkImageCount(coverId, mediaIds, fail) {
  if (coverId && mediaIds.length >= 9) fail('INVALID_INPUT', '配图与上传图片合计最多9张。');
}

module.exports = { readPresets, checkImageCount };

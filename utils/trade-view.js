// View generations protect private responses when a page is hidden, reopened,
// or explicitly denied. Order access itself remains a server decision.
function token(page) { return page._tradeView || 0; }
function current(page, value) { return !page._unloaded && !page._tradeHidden && token(page) === value; }
function invalidate(page) {
  page._tradeView = token(page) + 1;
  page._loading = false;
  page._messagesLoading = false;
  page._salesLoading = false;
}
function show(page) { invalidate(page); page._unloaded = false; page._tradeHidden = false; }
function hide(page) { invalidate(page); page._tradeHidden = true; }
function unload(page) { hide(page); page._unloaded = true; }
module.exports = { token, current, invalidate, show, hide, unload };

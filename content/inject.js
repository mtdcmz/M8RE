/* M8RE page-world bridge (runs in page main world, reads bpx player state)
 * 1. polls window.player.danmaku.isOpen() (nano API, real danmaku switch)
 * 2. hooks localStorage.setItem (bpx_player_profile writes incl. opacity)
 * Notifies the content script via postMessage (isolated world cannot read these)
 */
(function () {
  'use strict';
  if (window.__M8RE_INJECTED) return;
  window.__M8RE_INJECTED = true;

  function post(data) {
    try {
      data.source = 'm8re-inject';
      window.postMessage(data, location.origin);
    } catch (e) { }
  }

  // 1) danmaku switch (window.player = nano.createPlayer(...))
  var lastOpen = null;
  setInterval(function () {
    var open = null;
    try {
      var p = window.player;
      if (p && p.danmaku && typeof p.danmaku.isOpen === 'function') {
        open = !!p.danmaku.isOpen();
      }
    } catch (e) { }
    if (open !== null && open !== lastOpen) {
      lastOpen = open;
      post({ type: 'dm-state', open: open });
    }
  }, 400);

  // 2) danmaku settings persistence hook
  try {
    var origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      try { origSetItem.call(this, key, value); } catch (e) { }
      if (key === 'bpx_player_profile' || key === 'bilibili_player_settings') {
        post({ type: 'profile-write', key: key });
      }
    };
  } catch (e) { }
})();

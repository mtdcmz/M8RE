// M8RE background service worker - cross-origin fetch proxy only (CORS bypass, page cookies)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'm8re-fetch') return false;
  (async () => {
    try {
      // specialDm pack URLs arrive as http://; upgrade to https (mixed content)
      const url = String(msg.url).replace(/^http:\/\//i, 'https://');
      const resp = await fetch(url, {
        credentials: 'include',
        headers: msg.headers || {}
      });
      // sendMessage JSON-serializes: ArrayBuffer would arrive as {}. Ship base64.
      const bytes = new Uint8Array(await resp.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      sendResponse({ ok: resp.ok, status: resp.status, b64: btoa(bin) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async sendResponse
});

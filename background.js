'use strict';

const MIME_MAP = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  css: 'text/css', js: 'application/javascript',
  mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav',
};

const MAX_SIZE = 20 * 1024 * 1024; // 20MB per resource

function guessMime(url) {
  const ext = url.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'fetchResource') return;

  const { url, asText } = msg;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  fetch(url, { credentials: 'omit', signal: controller.signal })
    .then(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get('content-type')?.split(';')[0].trim() || guessMime(url);

      if (asText) {
        const text = await res.text();
        sendResponse({ ok: true, text, contentType });
      } else {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_SIZE) {
          sendResponse({ ok: false, error: 'Resource exceeds 20MB limit' });
          return;
        }
        const bytes = new Uint8Array(buf);
        let bin = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        sendResponse({ ok: true, dataUrl: `data:${contentType};base64,${btoa(bin)}` });
      }
    })
    .catch(err => sendResponse({
      ok: false,
      error: err.name === 'AbortError' ? 'Resource timed out after 15 seconds' : err.message,
    }))
    .finally(() => clearTimeout(timeout));

  return true; // keep channel open for async response
});

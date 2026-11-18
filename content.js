'use strict';

// Idempotency guard — safe to re-inject
if (!window.__htmlCaptureInjected) {
  window.__htmlCaptureInjected = true;

  // ── URL helpers ───────────────────────────────────────────────────────────

  function resolveUrl(raw, base) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('#') || s === 'about:blank') return null;
    try { return new URL(s, base).href; } catch { return null; }
  }

  // Extract all url() and @import urls from a CSS string, resolved against base
  function extractCssUrls(css, base) {
    const out = new Set();
    css.replace(/url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'">\s]*))\s*\)/gi, (_, a, b, c) => {
      const r = resolveUrl(a ?? b ?? c, base);
      if (r) out.add(r);
    });
    css.replace(/@import\s+(?:url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'">\s]*))\s*\)|'([^']*)'|"([^"]*)")\s*[^;]*;/gi, (_, a, b, c, d, e) => {
      const r = resolveUrl(a ?? b ?? c ?? d ?? e, base);
      if (r) out.add(r);
    });
    return [...out];
  }

  // Replace url() values in CSS using resMap
  function replaceCssUrls(css, base, resMap) {
    return css.replace(/url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'">\s]*))\s*\)/gi, (full, a, b, c) => {
      const r = resolveUrl(a ?? b ?? c, base);
      return (r && resMap[r]) ? `url("${resMap[r]}")` : full;
    });
  }

  function safeScriptText(js) {
    return String(js).replace(/<\/script/gi, '<\\/script');
  }

  function addUrl(set, raw, base) {
    const r = resolveUrl(raw, base);
    if (r) set.add(r);
  }

  function addSrcsetUrls(set, srcset, base) {
    String(srcset || '').split(',').forEach(part => {
      addUrl(set, part.trim().split(/\s+/)[0], base);
    });
  }

  function rewriteUrlAttr(el, attr, base, resMap) {
    const raw = el.getAttribute(attr);
    const r = resolveUrl(raw, base);
    if (r && resMap[r]) el.setAttribute(attr, resMap[r]);
  }

  function rewriteSrcsetAttr(el, attr, base, resMap) {
    const raw = el.getAttribute(attr);
    if (!raw) return;
    const newSrcset = raw.split(',').map(part => {
      const parts = part.trim().split(/\s+/);
      const r = resolveUrl(parts[0], base);
      const dataUrl = (r && resMap[r]) || parts[0];
      return parts.length > 1 ? `${dataUrl} ${parts.slice(1).join(' ')}` : dataUrl;
    }).join(', ');
    el.setAttribute(attr, newSrcset);
  }

  function sanitizeTimingValue(value) {
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return value;
  }

  function collectAnimationReplays() {
    if (!document.getAnimations) return [];
    const replays = [];
    let nextId = 0;

    try {
      document.getAnimations({ subtree: true }).forEach(animation => {
        const effect = animation.effect;
        const target = effect?.target;
        if (!(target instanceof Element) || !effect.getKeyframes || !effect.getTiming) return;

        const computed = getComputedStyle(target);
        const timing = effect.getTiming();
        const duration = timing.duration === 'auto' ? computed.animationDuration : timing.duration;
        if (duration === 0 || duration === '0s') return;

        let id = target.getAttribute('data-html-capture-animation-id');
        if (!id) {
          id = String(++nextId);
          target.setAttribute('data-html-capture-animation-id', id);
        }

        const serializedTiming = {};
        Object.keys(timing).forEach(key => {
          serializedTiming[key] = sanitizeTimingValue(timing[key]);
        });

        replays.push({
          id,
          keyframes: effect.getKeyframes(),
          timing: serializedTiming,
          playbackRate: animation.playbackRate || 1,
          currentTime: sanitizeTimingValue(animation.currentTime || 0),
        });
      });
    } catch {}

    return replays.slice(0, 250);
  }

  function injectAnimationReplay(clone, replays) {
    if (!replays.length) return;
    const script = document.createElement('script');
    script.textContent = `(() => {
  const replays = ${safeScriptText(JSON.stringify(replays))};
  const restore = value => value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : value;
  requestAnimationFrame(() => {
    for (const replay of replays) {
      const el = document.querySelector('[data-html-capture-animation-id="' + CSS.escape(replay.id) + '"]');
      if (!el || !el.animate) continue;
      const timing = {};
      for (const key in replay.timing) timing[key] = restore(replay.timing[key]);
      try {
        const animation = el.animate(replay.keyframes, timing);
        animation.playbackRate = replay.playbackRate;
        animation.currentTime = restore(replay.currentTime);
        animation.play();
      } catch {}
    }
  });
})();`;
    (clone.querySelector('body') || clone).appendChild(script);
  }

  // ── Background fetch bridge ───────────────────────────────────────────────

  let skippedResources = new Set();

  function bgFetch(url, asText = false) {
    return new Promise(resolve => {
      let settled = false;
      const finish = res => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (!res?.ok) skippedResources.add(url);
        resolve(res);
      };
      // Also bound the wait if the background worker or message channel stops.
      const timeout = setTimeout(() => finish(null), 20000);
      try {
        chrome.runtime.sendMessage({ action: 'fetchResource', url, asText }, res => {
          finish(chrome.runtime.lastError ? null : res);
        });
      } catch { finish(null); }
    });
  }

  // ── CSS processing (recursive @import support) ────────────────────────────

  async function fetchAndProcessCss(url, resMap, depth = 0) {
    if (depth > 5) return '';
    const cacheKey = '\x00css\x00' + url;
    if (resMap[cacheKey] !== undefined) return resMap[cacheKey];
    resMap[cacheKey] = ''; // mark in-progress to prevent cycles

    const res = await bgFetch(url, true);
    if (!res?.ok) return '';

    let css = res.text;

    // Collect @import statements before removing them
    const imports = [];
    css.replace(/@import\s+(?:url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'">\s]*))\s*\)|'([^']*)'|"([^"]*)")\s*[^;]*;/gi, (full, a, b, c, d, e) => {
      const importUrl = resolveUrl(a ?? b ?? c ?? d ?? e, url);
      if (importUrl) imports.push({ full, url: importUrl });
    });

    // Remove @import lines (they'll be prepended as inlined text)
    for (const imp of imports) {
      css = css.replace(imp.full, '');
    }

    // Recursively fetch and process imported CSS
    const importResults = await Promise.allSettled(
      imports.map(imp => fetchAndProcessCss(imp.url, resMap, depth + 1))
    );
    const importedCss = importResults.map(r => r.status === 'fulfilled' ? r.value : '').join('\n');
    css = importedCss + '\n' + css;

    // Fetch binary resources referenced in this CSS (fonts, background images)
    const binaryUrls = extractCssUrls(css, url).filter(u => !u.includes('\x00') && !resMap[u]);
    await Promise.allSettled(binaryUrls.map(async bUrl => {
      const r = await bgFetch(bUrl, false);
      if (r?.ok) resMap[bUrl] = r.dataUrl;
    }));

    // Replace url() references with data URIs
    css = replaceCssUrls(css, url, resMap);
    resMap[cacheKey] = css;
    return css;
  }

  // ── Progress ──────────────────────────────────────────────────────────────

  function reportProgress(stage, done, total) {
    try { chrome.runtime.sendMessage({ action: 'captureProgress', stage, done, total }); } catch {}
  }

  // ── Pre-capture: trigger scroll animations and let JS settle ──────────────

  async function preCapture() {
    reportProgress('animating', 0, 0);
    // Let JS initialize and apply animation state to the DOM
    await new Promise(r => setTimeout(r, 1500));

    document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach(el => {
      el.setAttribute('loading', 'eager');
    });

    // Scroll through the full page to fire IntersectionObserver / scroll-triggered animations
    const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const viewport = Math.max(window.innerHeight || 800, 600);
    const steps = Math.max(25, Math.ceil(pageHeight / Math.max(viewport * 0.55, 400)));
    for (let i = 0; i <= steps; i++) {
      window.scrollTo({ top: Math.round((pageHeight / steps) * i), behavior: 'instant' });
      await new Promise(r => setTimeout(r, 140));
    }
    window.scrollTo({ top: 0, behavior: 'instant' });

    await Promise.allSettled([...document.images].map(img => {
      if (img.complete) return Promise.resolve();
      if (img.decode) return img.decode().catch(() => {});
      return new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 2500);
      });
    }));

    // Wait for triggered animations and late lazy-load mutations to settle before snapshot
    await new Promise(r => setTimeout(r, 1000));
  }

  // ── Main capture ──────────────────────────────────────────────────────────

  async function capture() {
    skippedResources = new Set();
    await preCapture();
    const base = document.baseURI || location.href;
    const resMap = {};
    const animationReplays = collectAnimationReplays();

    // ── Phase 1: collect binary resource URLs from live DOM ─────────────────

    const binaryUrls = new Set();

    document.querySelectorAll('img').forEach(el => {
      addUrl(binaryUrls, el.currentSrc, base);
      addUrl(binaryUrls, el.src, base);
      addUrl(binaryUrls, el.getAttribute('src'), base);
      addUrl(binaryUrls, el.getAttribute('data-src'), base);
      addSrcsetUrls(binaryUrls, el.getAttribute('srcset'), base);
      addSrcsetUrls(binaryUrls, el.getAttribute('data-srcset'), base);
    });

    document.querySelectorAll('source').forEach(el => {
      addUrl(binaryUrls, el.getAttribute('src'), base);
      addSrcsetUrls(binaryUrls, el.getAttribute('srcset'), base);
      addSrcsetUrls(binaryUrls, el.getAttribute('data-srcset'), base);
    });

    document.querySelectorAll('video, audio').forEach(el => {
      addUrl(binaryUrls, el.currentSrc, base);
      addUrl(binaryUrls, el.getAttribute('src'), base);
      addUrl(binaryUrls, el.getAttribute('poster'), base);
    });

    document.querySelectorAll('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]').forEach(el => {
      addUrl(binaryUrls, el.getAttribute('href'), base);
    });

    document.querySelectorAll('svg image[href], svg image[xlink\\:href], image[href], image[xlink\\:href], use[href], use[xlink\\:href]').forEach(el => {
      addUrl(binaryUrls, el.getAttribute('href') || el.getAttribute('xlink:href'), base);
    });

    document.querySelectorAll('object[data], embed[src], input[type="image"][src]').forEach(el => {
      addUrl(binaryUrls, el.getAttribute('data') || el.getAttribute('src'), base);
    });

    try {
      performance.getEntriesByType('resource').forEach(entry => {
        if (['css', 'embed', 'img', 'image', 'input', 'object', 'video', 'audio'].includes(entry.initiatorType)) {
          addUrl(binaryUrls, entry.name, base);
        }
      });
    } catch {}

    document.querySelectorAll('[style]').forEach(el => {
      extractCssUrls(el.getAttribute('style') || '', base).forEach(u => binaryUrls.add(u));
    });

    document.querySelectorAll('style').forEach(el => {
      extractCssUrls(el.textContent || '', base).forEach(u => binaryUrls.add(u));
    });

    // ── Phase 2: identify external stylesheets and scripts ──────────────────

    const cssLinks = [...document.querySelectorAll('link[rel="stylesheet"][href]')];
    const scriptEls = [...document.querySelectorAll('script[src]')];
    const extraScriptUrls = new Set();
    try {
      performance.getEntriesByType('resource').forEach(entry => {
        if (entry.initiatorType === 'script') addUrl(extraScriptUrls, entry.name, base);
      });
    } catch {}
    scriptEls.forEach(el => {
      const src = resolveUrl(el.getAttribute('src'), base);
      if (src) extraScriptUrls.delete(src);
    });

    const total = binaryUrls.size + cssLinks.length + scriptEls.length + extraScriptUrls.size;
    let done = 0;
    reportProgress('fetching', done, total);

    // ── Phase 3: fetch binary resources ─────────────────────────────────────

    await Promise.allSettled([...binaryUrls].map(async url => {
      const r = await bgFetch(url, false);
      if (r?.ok) resMap[url] = r.dataUrl;
      reportProgress('fetching', ++done, total);
    }));

    // ── Phase 4: fetch and process CSS ───────────────────────────────────────

    const cssTextMap = {};
    await Promise.allSettled(cssLinks.map(async link => {
      const href = resolveUrl(link.getAttribute('href'), base);
      if (href) cssTextMap[href] = await fetchAndProcessCss(href, resMap);
      reportProgress('fetching', ++done, total);
    }));

    // ── Phase 5: fetch scripts ───────────────────────────────────────────────

    const scriptTextMap = {};
    await Promise.allSettled(scriptEls.map(async el => {
      const src = resolveUrl(el.getAttribute('src'), base);
      if (src) {
        const r = await bgFetch(src, true);
        if (r?.ok) scriptTextMap[src] = r.text;
      }
      reportProgress('fetching', ++done, total);
    }));

    await Promise.allSettled([...extraScriptUrls].map(async src => {
      const r = await bgFetch(src, true);
      if (r?.ok) scriptTextMap[src] = r.text;
      reportProgress('fetching', ++done, total);
    }));

    reportProgress('assembling', total, total);

    // ── Phase 6: clone DOM and rewrite all references ────────────────────────

    const clone = document.documentElement.cloneNode(true);

    // Remove things that would cause issues or are useless in a static file
    clone.querySelectorAll('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="X-Content-Security-Policy"]').forEach(el => el.remove());
    clone.querySelectorAll('base').forEach(el => el.remove());
    clone.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"], link[rel="preload"], link[rel="modulepreload"]').forEach(el => el.remove());

    // Inline external CSS as <style> tags
    clone.querySelectorAll('link[rel="stylesheet"][href]').forEach(link => {
      const href = resolveUrl(link.getAttribute('href'), base);
      if (href && cssTextMap[href]) {
        const style = document.createElement('style');
        style.textContent = cssTextMap[href];
        link.replaceWith(style);
      }
      // else: leave link in place so it can load remotely if accessible
    });

    // Process inline <style> url() references
    clone.querySelectorAll('style').forEach(el => {
      el.textContent = replaceCssUrls(el.textContent || '', base, resMap);
    });

    // Inline external scripts (preserves click handlers, dropdown toggles, modals, etc.)
    clone.querySelectorAll('script[src]').forEach(el => {
      const src = resolveUrl(el.getAttribute('src'), base);
      if (src && scriptTextMap[src]) {
        const s = document.createElement('script');
        if (el.type && el.type !== 'text/javascript' && el.type !== 'module') s.type = el.type;
        s.textContent = safeScriptText(scriptTextMap[src]);
        el.replaceWith(s);
      }
      // else: leave as-is
    });

    [...extraScriptUrls].forEach(src => {
      if (!scriptTextMap[src]) return;
      const s = document.createElement('script');
      s.dataset.htmlCaptureExtraScript = 'true';
      s.textContent = safeScriptText(scriptTextMap[src]);
      (clone.querySelector('body') || clone).appendChild(s);
    });

    injectAnimationReplay(clone, animationReplays);

    // Rewrite img src
    clone.querySelectorAll('img').forEach(el => {
      rewriteUrlAttr(el, 'src', base, resMap);
      rewriteUrlAttr(el, 'data-src', base, resMap);
      rewriteSrcsetAttr(el, 'srcset', base, resMap);
      rewriteSrcsetAttr(el, 'data-srcset', base, resMap);
    });

    // Rewrite srcset
    clone.querySelectorAll('source').forEach(el => {
      rewriteUrlAttr(el, 'src', base, resMap);
      rewriteSrcsetAttr(el, 'srcset', base, resMap);
      rewriteSrcsetAttr(el, 'data-srcset', base, resMap);
    });

    // Rewrite video/audio sources
    clone.querySelectorAll('video, audio').forEach(el => {
      rewriteUrlAttr(el, 'src', base, resMap);
      rewriteUrlAttr(el, 'poster', base, resMap);
    });

    // Rewrite favicons
    clone.querySelectorAll('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]').forEach(el => {
      rewriteUrlAttr(el, 'href', base, resMap);
    });

    clone.querySelectorAll('svg image[href], svg image[xlink\\:href], image[href], image[xlink\\:href], use[href], use[xlink\\:href]').forEach(el => {
      rewriteUrlAttr(el, 'href', base, resMap);
      rewriteUrlAttr(el, 'xlink:href', base, resMap);
    });

    clone.querySelectorAll('object[data], embed[src], input[type="image"][src]').forEach(el => {
      rewriteUrlAttr(el, 'data', base, resMap);
      rewriteUrlAttr(el, 'src', base, resMap);
    });

    // Rewrite inline style url()
    clone.querySelectorAll('[style]').forEach(el => {
      const s = el.getAttribute('style');
      if (s) el.setAttribute('style', replaceCssUrls(s, base, resMap));
    });

    // ── Same-origin iframes ──────────────────────────────────────────────────

    const liveIframes = [...document.querySelectorAll('iframe')];
    const cloneIframes = [...clone.querySelectorAll('iframe')];

    for (let i = 0; i < liveIframes.length; i++) {
      try {
        const iDoc = liveIframes[i].contentDocument;
        if (!iDoc?.documentElement) continue;
        const iBase = iDoc.baseURI || iDoc.URL || base;
        const iClone = iDoc.documentElement.cloneNode(true);

        // Rewrite known resources in the iframe using the already-fetched resMap
        iClone.querySelectorAll('img[src]').forEach(el => {
          const r = resolveUrl(el.getAttribute('src'), iBase);
          if (r && resMap[r]) el.setAttribute('src', resMap[r]);
        });
        iClone.querySelectorAll('[style]').forEach(el => {
          const s = el.getAttribute('style');
          if (s) el.setAttribute('style', replaceCssUrls(s, iBase, resMap));
        });
        iClone.querySelectorAll('style').forEach(el => {
          el.textContent = replaceCssUrls(el.textContent || '', iBase, resMap);
        });

        cloneIframes[i].removeAttribute('src');
        cloneIframes[i].setAttribute('srcdoc', '<!DOCTYPE html>\n' + iClone.outerHTML);
      } catch {
        // cross-origin — leave as-is
      }
    }

    // ── Serialize ─────────────────────────────────────────────────────────────

    const credit = 'Captured with HTML Capture by Ojelola Ojelabi. https://github.com/oj-create/html-capture';
    const head = clone.querySelector('head');
    if (head) {
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'generator');
      meta.setAttribute('content', 'HTML Capture by Ojelola Ojelabi');
      const charset = head.querySelector('meta[charset]');
      if (charset) charset.after(meta); else head.insertBefore(meta, head.firstChild);
    }
    return '<!DOCTYPE html>\n<!-- ' + credit + ' -->\n' + clone.outerHTML;
  }

  // ── Download ──────────────────────────────────────────────────────────────

  function triggerDownload(html) {
    const title = (document.title || 'capture')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 60) || 'capture';
    const date = new Date().toISOString().split('T')[0];
    const filename = `${title}-${date}.html`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);

    return { filename, size: html.length };
  }

  // ── Message listener ──────────────────────────────────────────────────────

  let capturing = false;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action !== 'startCapture') return;
    if (capturing) {
      sendResponse({ accepted: false, error: 'A capture is already running. Wait for it to finish.' });
      return false;
    }
    capturing = true;
    sendResponse({ accepted: true });

    capture()
      .then(html => {
        const { filename, size } = triggerDownload(html);
        chrome.runtime.sendMessage({ action: 'captureResult', ok: true, size, filename, skipped: skippedResources.size });
      })
      .catch(err => {
        chrome.runtime.sendMessage({ action: 'captureResult', ok: false, error: err.message });
      })
      .finally(() => { capturing = false; });

    return false;
  });
}

'use strict';

const $ = id => document.getElementById(id);

function showState(name) {
  ['ready', 'capturing', 'complete', 'error'].forEach(s => {
    $('state-' + s).classList.toggle('hidden', s !== name);
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

const STAGE_LABELS = {
  animating: 'Triggering animations…',
  fetching: 'Fetching assets…',
  assembling: 'Assembling HTML…',
};

let activeTabId = null;
let msgListener = null;

function setupListener() {
  if (msgListener) chrome.runtime.onMessage.removeListener(msgListener);

  msgListener = (msg) => {
    if (msg.action === 'captureProgress') {
      $('progressStage').textContent = STAGE_LABELS[msg.stage] || 'Working…';
      if (msg.total > 0) {
        $('progressCount').textContent = `${msg.done} / ${msg.total}`;
        $('progressBar').style.width = Math.round((msg.done / msg.total) * 100) + '%';
      }
    } else if (msg.action === 'captureResult') {
      if (msg.ok) {
        $('resultMeta').textContent = `${formatSize(msg.size)}  ·  ${msg.filename}` +
          (msg.skipped ? `  ·  ${msg.skipped} assets skipped. Some content may need a network connection.` : '');
        showState('complete');
      } else {
        $('errorMsg').textContent = msg.error || 'Unknown error';
        showState('error');
      }
    }
  };

  chrome.runtime.onMessage.addListener(msgListener);
}

async function startCapture() {
  if (!activeTabId) return;

  showState('capturing');
  $('progressBar').style.width = '0%';
  $('progressStage').textContent = 'Starting…';
  $('progressCount').textContent = '';
  setupListener();

  try {
    // Inject content script (idempotent, safe to call multiple times)
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['content.js'],
    });

    // Trigger capture (result comes back via runtime.onMessage)
    const response = await chrome.tabs.sendMessage(activeTabId, { action: 'startCapture' });
    if (!response?.accepted) throw new Error(response?.error || 'Capture did not start. Refresh the page and try again.');
  } catch (err) {
    $('errorMsg').textContent = err.message;
    showState('error');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab.id;

  const blocked = !tab.url || ['chrome://', 'about:', 'chrome-extension://', 'edge://'].some(p => tab.url.startsWith(p));

  if (blocked) {
    showState('ready');
    const btn = $('captureBtn');
    btn.textContent = 'Cannot capture this page';
    btn.className = 'btn btn-disabled';
    btn.disabled = true;
    return;
  }

  showState('ready');

  $('captureBtn').addEventListener('click', startCapture);
  $('captureAgainBtn').addEventListener('click', startCapture);
  $('retryBtn').addEventListener('click', startCapture);
});

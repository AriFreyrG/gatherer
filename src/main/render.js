// Loads a page in a hidden browser window and returns the HTML its scripts produced. Used when a
// plain fetch finds no readable content, which is what script-built pages (single-page apps)
// give. The window runs the site's scripts in Chromium's sandbox, with no Node access, no
// stored cookies (an in-memory session), no popups, no downloads, no sound and no permissions.
const { UA } = require('./scraper');
const PARTITION = 'gatherer-render'; // no "persist:" prefix: nothing is written to disk

let configured = false;
function configure(ses) {
  if (configured) return;
  configured = true;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.on('will-download', (e) => e.preventDefault());
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { html, finalUrl }. Waits for the load, then until the page's text stops growing.
async function renderPage(url, { timeout = 25000, settleMax = 6000 } = {}) {
  const { BrowserWindow, session } = require('electron');
  const ses = session.fromPartition(PARTITION);
  configure(ses);
  const win = new BrowserWindow({
    show: false, width: 1280, height: 1000, paintWhenInitiallyHidden: true,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, webgl: false, spellcheck: false },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, to) => { if (!/^https?:/i.test(to)) e.preventDefault(); });
  try {
    const loaded = wc.loadURL(url, { userAgent: UA }).catch((e) => {
      // Sub-frame and aborted-redirect errors still leave a usable page; only fail when nothing loaded.
      if (!wc.getURL() || wc.getURL() === 'about:blank') throw e;
    });
    let timer;
    await Promise.race([loaded, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeout); })]).finally(() => clearTimeout(timer));
    // Script-built pages keep filling in after "load"; stop once the text is stable.
    const start = Date.now();
    let last = -1;
    while (Date.now() - start < settleMax) {
      await wait(500);
      const len = await wc.executeJavaScript('document.body ? document.body.innerText.length : 0', true).catch(() => 0);
      if (len > 0 && len === last) break;
      last = len;
    }
    const html = await wc.executeJavaScript('"<!doctype html>" + document.documentElement.outerHTML', true);
    return { html, finalUrl: wc.getURL() || url };
  } catch (e) {
    throw new Error(`Could not load ${new URL(url).hostname} (${e.message})`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { renderPage };

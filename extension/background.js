// Send to Gatherer: hands pages to the Gatherer app on this computer.
// The toolbar button and "Save page" send the page as the browser shows it, so sites that only
// work in a browser (Reddit, script-built apps, pages you're signed in to) are saved properly.
// It goes straight to the app on 127.0.0.1; nothing is uploaded anywhere. "Save link" and
// pages the extension can't read send only the address, through the gatherer:// link.
const api = globalThis.browser || globalThis.chrome;
const INBOX = 'http://127.0.0.1:47615';

const isWebPage = (u) => /^https?:\/\//i.test(u || '');
const captureLink = (url, title) => {
  const q = new URLSearchParams({ url });
  if (title) q.set('title', title);
  return `gatherer://add?${q}`;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens a gatherer:// link from inside the page, so the tab stays where it is; the browser asks
// once whether to open Gatherer, then hands the link to the app.
async function openLink(tab, link) {
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, func: (href) => { window.location.href = href; }, args: [link] });
  } catch {
    // Pages the extension can't script (the web store, PDFs in some browsers): navigate the
    // tab to the link instead. Browsers open external links without leaving the page.
    await api.tabs.update(tab.id, { url: link });
  }
}

async function readPage(tab) {
  try {
    const [res] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ url: location.href, title: document.title, html: '<!doctype html>' + document.documentElement.outerHTML }),
    });
    return res && res.result && res.result.html ? res.result : null;
  } catch { return null; }
}

async function post(page) {
  try {
    const res = await fetch(`${INBOX}/pages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gatherer': '1' }, body: JSON.stringify(page),
    });
    return res.ok;
  } catch { return false; } // Gatherer isn't running (or is an older version)
}

async function sendPage(tab) {
  if (!isWebPage(tab.url)) { flag(tab, '!', 'Only web pages can be saved to Gatherer'); return; }
  const page = await readPage(tab);
  if (!page || !isWebPage(page.url)) return sendLink(tab, tab.url, tab.title);
  flag(tab, '…', 'Sending to Gatherer', 0);
  if (!(await post(page))) {
    // Start Gatherer with a link it ignores, then hand it the page once it is listening.
    await openLink(tab, 'gatherer://open');
    let sent = false;
    for (let i = 0; i < 20 && !sent; i++) { await wait(1000); sent = await post(page); }
    if (!sent) return sendLink(tab, page.url, page.title); // older Gatherer: let it fetch the page itself
  }
  flag(tab, '✓', 'Sent to Gatherer');
}

async function sendLink(tab, url, title) {
  if (!isWebPage(url)) { flag(tab, '!', 'Only web pages can be saved to Gatherer'); return; }
  await openLink(tab, captureLink(url, title));
  flag(tab, '✓', 'Sent to Gatherer');
}

function flag(tab, text, title, clearAfter = 2500) {
  api.action.setBadgeText({ tabId: tab.id, text });
  api.action.setBadgeBackgroundColor({ tabId: tab.id, color: text === '!' ? '#d92d20' : '#3b5bdb' });
  api.action.setTitle({ tabId: tab.id, title });
  if (!clearAfter) return;
  setTimeout(() => {
    api.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});
    api.action.setTitle({ tabId: tab.id, title: 'Save this page to Gatherer' }).catch(() => {});
  }, clearAfter);
}

api.action.onClicked.addListener((tab) => sendPage(tab));

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: 'gatherer-page', title: 'Save page to Gatherer', contexts: ['page'] });
    api.contextMenus.create({ id: 'gatherer-link', title: 'Save link to Gatherer', contexts: ['link'] });
  });
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'gatherer-link') sendLink(tab, info.linkUrl, info.linkText || '');
  else sendPage(tab);
});

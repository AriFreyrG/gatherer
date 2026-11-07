// Send to Gatherer: hands pages to the Gatherer app through its gatherer:// link.
// The app fetches and saves the page itself, so nothing is uploaded anywhere.
const api = globalThis.browser || globalThis.chrome;

const isWebPage = (u) => /^https?:\/\//i.test(u || '');
const captureLink = (url, title) => {
  const q = new URLSearchParams({ url });
  if (title) q.set('title', title);
  return `gatherer://add?${q}`;
};

async function send(tab, url, title) {
  if (!isWebPage(url)) { flag(tab, '!', 'Only web pages can be saved to Gatherer'); return; }
  const link = captureLink(url, title);
  try {
    // Opening the link from inside the page keeps the tab where it is; the browser asks once
    // whether to open Gatherer, then hands the link to the app.
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: (href) => { window.location.href = href; },
      args: [link],
    });
  } catch {
    // Pages the extension can't script (the web store, PDFs in some browsers): navigate the
    // tab to the link instead. Browsers open external links without leaving the page.
    await api.tabs.update(tab.id, { url: link });
  }
  flag(tab, '✓', 'Sent to Gatherer');
}

function flag(tab, text, title) {
  api.action.setBadgeText({ tabId: tab.id, text });
  api.action.setBadgeBackgroundColor({ tabId: tab.id, color: text === '✓' ? '#3b5bdb' : '#d92d20' });
  api.action.setTitle({ tabId: tab.id, title });
  setTimeout(() => {
    api.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});
    api.action.setTitle({ tabId: tab.id, title: 'Save this page to Gatherer' }).catch(() => {});
  }, 2500);
}

api.action.onClicked.addListener((tab) => send(tab, tab.url, tab.title));

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: 'gatherer-page', title: 'Save page to Gatherer', contexts: ['page'] });
    api.contextMenus.create({ id: 'gatherer-link', title: 'Save link to Gatherer', contexts: ['link'] });
  });
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'gatherer-link') send(tab, info.linkUrl, info.linkText || '');
  else send(tab, info.pageUrl || tab.url, tab.title);
});

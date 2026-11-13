# Send to Gatherer

Save the page you're reading to Gatherer without copying its URL.

The browser extension sends the page **as your browser shows it**, straight to the Gatherer
app on your computer (`http://127.0.0.1:47615`, loopback only; nothing is uploaded). That is
how sites that only work in a browser get saved: Reddit posts with their comments, apps built
by scripts, and pages you're signed in to. If Gatherer isn't running, the extension starts it
and sends the page once it's ready.

Saving a link, the bookmarklet and drag and drop send only the address, through the app's
`gatherer://` link, and Gatherer downloads the page itself:

```
gatherer://add?url=<page URL>&title=<page title>
```

Gatherer opens (or comes to the front) and opens the new note. A page you've already
gathered just opens its existing note.

## Browser extension (Chrome, Edge, Brave, Arc, Firefox)

- Toolbar button: saves the current page.
- Right-click a page: **Save page to Gatherer**. Right-click a link: **Save link to Gatherer**.
- Keyboard shortcut: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>.

Install it unpacked while it isn't in a store:

- **Chrome / Edge / Brave / Arc:** open `chrome://extensions`, turn on Developer mode,
  click **Load unpacked** and pick this `extension` folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**
  and pick `manifest.json`.

The first time, the browser asks whether to open Gatherer. Tick "Always allow" so later
saves are a single click. In Firefox, also allow the extension to access 127.0.0.1 when it
asks (or under the extension's **Permissions** tab), so it can hand pages to the app.

After updating the extension folder, click the reload button on the extension's card.

## Bookmarklet (Safari and any other browser)

In Gatherer, click **New note**, then **Copy bookmarklet**. Add a bookmark to your bookmarks
bar and paste the copied text as its address. Clicking it on any page sends that page to
Gatherer.

```
javascript:(()=>{location.href='gatherer://add?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)})()
```

## Drag and drop

Drag a link, or the address from the browser's address bar, onto the Gatherer window.

## What gets saved

The toolbar button, the keyboard shortcut and **Save page to Gatherer** send the page's
HTML as it is in your tab, so what you see is what gets saved (for Reddit, the comments
that are loaded on the page). **Save link to Gatherer**, the bookmarklet and drag and drop
send only the address; Gatherer downloads the page itself, so pages that need you to be
signed in may save only their public part, and Reddit posts need the extension button.

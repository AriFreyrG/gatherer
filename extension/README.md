# Send to Gatherer

Save the page you're reading to Gatherer without copying its URL.

Everything goes through the app's `gatherer://` link, so it works with every build of
Gatherer, including the sandboxed Mac App Store one:

```
gatherer://add?url=<page URL>&title=<page title>
```

Gatherer opens (or comes to the front), fetches the page and opens the new note. A page
you've already gathered just opens its existing note.

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
saves are a single click.

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

Only the page's address is sent. Gatherer downloads the page itself, so pages that need you
to be signed in may save only their public part.

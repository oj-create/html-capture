# HTML Capture

A Chrome extension that saves any web page as a single HTML file.

Hover states, dropdowns and modals still work in the saved file. Images, fonts, styles and scripts are packed inside it, so you can open it without the original site and send it to anyone.

I built it to get real product screens for videos, articles and mockups, without asking for access to the code. If you make content with AI tools, you can hand the file to one and edit the text, swap the data, or animate the screen.

## Install (about 2 minutes)

1. **Download** [html-capture.zip](https://github.com/oj-create/html-capture/releases/latest/download/html-capture.zip) from the latest release.
2. **Unzip** it. You get a folder called `html-capture`.
3. **Open** `chrome://extensions` in Chrome.
4. **Turn on** Developer mode (the switch in the top right).
5. **Click** Load unpacked, then choose the `html-capture` folder.
6. **Pin it:** click the puzzle icon in the toolbar, then the pin next to HTML Capture.

Keep the folder where it is. Chrome loads the extension from that folder each time.

## Use it

1. Open the page you want to capture.
2. Click the HTML Capture icon, then **Capture Page**.
3. It scrolls through the page so lazy images and scroll animations load, then an `.html` file downloads. Open it in any browser.

## What it keeps

- Images, fonts, stylesheets and scripts, packed into the file
- Hover effects, so buttons and menus still react
- Dropdowns and modals that open with a click
- The page as you see it, including pages you're signed in to

Each saved file starts with a short credit line and a `generator` tag naming HTML Capture. Neither shows on the page.

## Limits

- A file that takes longer than 15 seconds to load, or is larger than 20 MB, is skipped and stays linked to the live site. The extension tells you how many were skipped.
- Cross-origin iframes stay linked to their live source.
- Very dynamic apps may not behave exactly like the live page.
- Tested in Chrome.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Reads the page you're on when you click Capture Page |
| Access to all sites | Downloads that page's own images, fonts and styles to pack them into the file |

Nothing is sent to any server. The capture happens in your browser and the file goes to your Downloads folder.

## Update

Download the new release, replace the old folder with the new one, then click the reload icon on the extension in `chrome://extensions`.

## For developers

No build step. Edit the files and reload the extension.

```
node --test tests/timeouts.test.cjs
```

## License

MIT. See [LICENSE](LICENSE).

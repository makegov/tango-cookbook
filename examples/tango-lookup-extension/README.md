# Tango Lookup

A Chrome extension for quick lookups of federal contracts, entities, and opportunities in the [Tango API](https://docs.makegov.com/).

![Tango Lookup demo: searching a vendor by name, a contract by PIID, pivoting to the recipient, and an opportunity by solicitation number](demo.gif)

## Features

- Search by UEI, PIID, solicitation number, award key, or name
- Full-text opportunity search — "Golden Dome" finds the Golden Dome CSO, not just exact solicitation-number matches
- View entity, contract, IDV, and opportunity details in a compact card UI
- Expand any result to see the full API response
- Right-click context menu to look up selected text

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `examples/tango-lookup-extension/` directory.

## Configuration

1. Click the extension icon, then open **Settings** (or right-click the icon and choose **Options**).
2. Enter your Tango API key. You can get one at [tango.makegov.com](https://tango.makegov.com/).
3. Click **Save**.

## Usage

- Click the extension icon and type a search query (UEI, PIID, solicitation number, award key, or name).
- Results appear as cards with key fields. Click **Expand** on any card to see the full API response.
- Right-click selected text on any page and choose **Lookup in Tango** to search directly.

## Development

The extension is built with vanilla JavaScript -- no build step required. Edit the source files and reload the extension in `chrome://extensions/`.

Key files:

- `manifest.json` -- extension manifest (Manifest V3)
- `popup.html` / `popup.js` -- main popup UI and search logic
- `options.html` / `options.js` -- settings page
- `background.js` -- context menu handler

## License

[MIT](../../LICENSE)

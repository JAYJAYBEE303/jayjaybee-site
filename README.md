# resources/

Static assets live here. Empty for now.

Suggested structure when you start adding things:

- `resources/images/` — project screenshots, photography
- `resources/icons/` — wordmark or favicon SVGs (no icon system; one or two only)
- `resources/fonts/` — only if self-hosting; the live site currently pulls Newsreader / Hanken Grotesk / IBM Plex Mono from Google Fonts

Reference assets from HTML/CSS with relative paths, e.g.
`<img src="resources/images/fc26.png" alt="FC26 Feel Calculator" />`.

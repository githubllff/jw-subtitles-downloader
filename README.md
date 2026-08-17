# JW Subtitles Downloader

An Obsidian plugin that downloads VTT subtitles from JW.ORG video pages and creates one note per video in a folder named by year.

## Status

Early development. The first version uses URLs listed in `JW Subtitle Sources.md`.

## Build

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and any generated styles into an Obsidian vault plugin folder:

```text
<Vault>/.obsidian/plugins/jw-subtitles-downloader/
```

Enable the plugin in Obsidian, create `JW Subtitle Sources.md`, add JW.ORG page URLs, then run **Sync JW subtitles**.

## Note

Use a reasonable request delay and verify JW.ORG terms and permissions before distributing the plugin.

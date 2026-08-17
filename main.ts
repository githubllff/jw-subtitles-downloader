import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl } from 'obsidian';

interface Settings { rootFolder: string; language: string; requestDelayMs: number; }
const DEFAULT_SETTINGS: Settings = { rootFolder: 'JW Subtitles', language: 'E', requestDelayMs: 750 };
interface Item { id: string; title: string; year: number; pageUrl: string; }

export default class JwSubtitlesPlugin extends Plugin {
  settings!: Settings;
  cancelling = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addCommand({ id: 'sync', name: 'Sync JW subtitles', callback: () => this.sync() });
    this.addCommand({ id: 'cancel', name: 'Cancel JW subtitle sync', callback: () => { this.cancelling = true; } });
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  private async log(source: TFile, message: string) {
    const line = `- ${new Date().toISOString()} ${message}`;
    let text = await this.app.vault.read(source);
    if (!text.includes('## Sync log')) text += '\n\n## Sync log\n';
    text += `${line}\n`;
    await this.app.vault.modify(source, text);
  }

  async sync() {
    this.cancelling = false;
    const source = this.app.vault.getAbstractFileByPath('JW Subtitle Sources.md');
    if (!(source instanceof TFile)) { new Notice('Create JW Subtitle Sources.md with JW.ORG URLs first'); return; }
    await this.log(source, '--- sync started ---');

    const text = await this.app.vault.read(source);
    const urls = [...text.matchAll(/https?:\/\/www\.jw\.org\/[^\s)]+/gi)].map(match => match[0]);
    if (!urls.length) { await this.log(source, 'No JW.ORG URLs found'); new Notice('No JW.ORG URLs found in JW Subtitle Sources.md'); return; }

    let discovered = 0, downloaded = 0, skipped = 0, failed = 0;
    const seen = new Set<string>();
    for (const url of urls) {
      if (this.cancelling) break;
      try {
        await this.log(source, `source=${url}`);
        const html = (await requestUrl({ url })).text;
        const id = extractId(html) || extractId(url);
        await this.log(source, `extractedId=${id ?? '(none)'} htmlLength=${html.length}`);
        if (!id) { skipped++; await this.log(source, 'SKIP no video ID'); continue; }
        if (seen.has(id)) { skipped++; await this.log(source, `SKIP duplicate ID ${id}`); continue; }
        seen.add(id); discovered++;

        const year = Number(url.match(/\/(\d{4})-/)?.[1] || new Date().getFullYear());
        const title = decodeHtml(meta(html, 'og:title')) || id;
        const result = await this.download(id, source);
        if (!result) { skipped++; await this.log(source, `SKIP no subtitle returned for ${id}`); continue; }
        await this.write({ id, title, year, pageUrl: url }, result);
        downloaded++;
        await this.log(source, `OK wrote note title=${JSON.stringify(title)} chars=${result.length}`);
        await sleep(this.settings.requestDelayMs);
      } catch (error) {
        failed++;
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        await this.log(source, `ERROR ${detail}`);
        console.error(`JW subtitle sync failed for ${url}`, error);
      }
    }
    await this.log(source, `--- sync finished downloaded=${downloaded} discovered=${discovered} skipped=${skipped} failed=${failed} ---`);
    new Notice(`${this.cancelling ? 'Cancelled' : 'Sync complete'}: ${downloaded} notes; ${discovered} discovered, ${skipped} skipped, ${failed} failed`);
  }

  async download(id: string, source: TFile): Promise<string | null> {
    const api = `https://b.jw-cdn.org/apis/mediator/v1/media-items/${encodeURIComponent(this.settings.language)}/${encodeURIComponent(id)}?clientType=www`;
    await this.log(source, `API ${api}`);
    const response = await requestUrl({ url: api });
    const data = response.json;
    const media = Array.isArray(data.media) ? data.media : [];
    const files = media[0]?.files || data.files || [];
    await this.log(source, `API response keys=${Object.keys(data).join(',')} mediaCount=${media.length} fileCount=${files.length}`);
    const candidates = files.flatMap((file: any) => [
      file.subtitles?.url,
      file.url && /\.(vtt|srt)(\?|$)/i.test(file.url) ? file.url : undefined,
      file.textTracks?.find((track: any) => track.src)?.src,
      file.tracks?.find((track: any) => track.src)?.src,
    ].filter(Boolean));
    await this.log(source, `subtitleCandidates=${candidates.length} ${candidates.join(' | ') || '(none)'}`);
    const track = candidates[0];
    if (!track) return null;
    const subtitleResponse = await requestUrl({ url: track });
    await this.log(source, `subtitleHTTP=${subtitleResponse.status} contentType=${subtitleResponse.headers['content-type'] || '(unknown)'}`);
    return subtitleResponse.text;
  }

  async write(item: Item, vtt: string) {
    const folder = normalizePath(`${this.settings.rootFolder}/${item.year}`);
    await this.app.vault.createFolder(this.settings.rootFolder).catch(() => undefined);
    await this.app.vault.createFolder(folder).catch(() => undefined);
    const path = normalizePath(`${folder}/${safe(item.title)}.md`);
    const text = ['---', `jwVideoId: ${item.id}`, `title: ${JSON.stringify(item.title)}`, `year: ${item.year}`, `source: ${item.pageUrl}`, '---', '', `# ${item.title}`, '', `Source: [JW.ORG](${item.pageUrl})`, '', '## Subtitles', '', vtt.trim(), ''].join('\n');
    const old = this.app.vault.getAbstractFileByPath(path);
    if (old instanceof TFile) await this.app.vault.modify(old, text); else await this.app.vault.create(path, text);
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, public plugin: JwSubtitlesPlugin) { super(app, plugin); }
  display() { this.containerEl.empty(); new Setting(this.containerEl).setName('Root folder').addText(text => text.setValue(this.plugin.settings.rootFolder).onChange(async value => { this.plugin.settings.rootFolder = value || DEFAULT_SETTINGS.rootFolder; await this.plugin.saveData(this.plugin.settings); })); new Setting(this.containerEl).setName('Language code').addText(text => text.setValue(this.plugin.settings.language).onChange(async value => { this.plugin.settings.language = value.toUpperCase(); await this.plugin.saveData(this.plugin.settings); })); }
}
function extractId(value: string): string | null { const decoded = value.replace(/\\\\\//g, '/').replace(/\\u002F/gi, '/'); const pub = decoded.match(/pub-[A-Za-z0-9_-]+/i)?.[0]; if (pub) return pub; try { const url = new URL(value); return url.searchParams.get('docid') || url.searchParams.get('lank') || null; } catch { return null; } }
function meta(html: string, property: string): string { return html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)`, 'i'))?.[1] || ''; }
function decodeHtml(value: string): string { const el = document.createElement('textarea'); el.innerHTML = value; return el.value; }
function safe(value: string): string { return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180); }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

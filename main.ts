import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl } from 'obsidian';

type OutputMode = 'vtt' | 'plain' | 'both';
type SyncSource = 'file' | 'online';
type Category = 'broadcasting' | 'talks' | 'news-reports' | 'morning-worship' | 'other';

interface Settings {
  rootFolder: string;
  language: string;
  requestDelayMs: number;
  outputMode: OutputMode;
  syncSource: SyncSource;
  onlineBroadcasting: boolean;
  onlineTalks: boolean;
  onlineNewsReports: boolean;
  onlineMorningWorship: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  rootFolder: 'JW Subtitles',
  language: 'E',
  requestDelayMs: 750,
  outputMode: 'both',
  syncSource: 'file',
  onlineBroadcasting: true,
  onlineTalks: true,
  onlineNewsReports: true,
  onlineMorningWorship: true
};

const ONLINE_CATEGORIES: Array<{ category: Category; key: string; url: string; enabled: keyof Settings }> = [
  { category: 'broadcasting', key: 'StudioMonthlyPrograms', url: 'https://www.jw.org/en/library/videos/#en/categories/StudioMonthlyPrograms', enabled: 'onlineBroadcasting' },
  { category: 'talks', key: 'StudioTalks', url: 'https://www.jw.org/en/library/videos/#en/categories/StudioTalks', enabled: 'onlineTalks' },
  { category: 'news-reports', key: 'StudioNewsReports', url: 'https://www.jw.org/en/library/videos/#en/categories/StudioNewsReports', enabled: 'onlineNewsReports' },
  { category: 'morning-worship', key: 'VODPgmEvtMorningWorship', url: 'https://www.jw.org/en/library/videos/#en/categories/VODPgmEvtMorningWorship', enabled: 'onlineMorningWorship' }
];

interface MediaDetails { id: string; title: string; speaker?: string; year: number; category: Category; pageUrl: string; vtt: string; }
interface SourceLink { url: string; title?: string; category?: Category; }

export default class JwSubtitlesPlugin extends Plugin {
  settings!: Settings;
  cancelling = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addCommand({ id: 'sync', name: 'Sync JW subtitles', callback: () => this.sync() });
    this.addCommand({ id: 'cancel', name: 'Cancel JW subtitle sync', callback: () => { this.cancelling = true; } });
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  private async log(source: TFile | null, message: string) {
    if (!source) return;
    let text = await this.app.vault.read(source);
    if (!text.includes('## Sync log')) text += '\n\n## Sync log\n';
    text += `- ${new Date().toISOString()} ${message}\n`;
    await this.app.vault.modify(source, text);
  }

  async sync() {
    this.cancelling = false;
    const sourceFile = this.app.vault.getAbstractFileByPath('JW Subtitle Sources.md');
    const source = sourceFile instanceof TFile ? sourceFile : null;
    await this.log(source, `--- sync started source=${this.settings.syncSource} ---`);

    let links: SourceLink[] = [];
    try {
      links = this.settings.syncSource === 'online' ? await this.onlineLinks() : await this.fileLinks(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.log(source, `ERROR collecting sources: ${message}`);
      new Notice(`Could not collect video sources: ${message}`);
      return;
    }

    if (!links.length) {
      await this.log(source, 'No JW.ORG video links found');
      new Notice('No JW.ORG video links found');
      return;
    }

    const existingIds = this.settings.syncSource === 'online' ? await this.existingVideoIds() : new Set<string>();
    let discovered = 0;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    const seen = new Set<string>();

    for (const link of links) {
      if (this.cancelling) break;
      try {
        const id = extractId(link.url);
        if (!id || seen.has(id) || existingIds.has(id)) {
          skipped++;
          continue;
        }
        seen.add(id);
        discovered++;

        const media = await this.fetchMedia(id, link);
        if (!media) {
          skipped++;
          await this.log(source, `SKIP no VTT or media info for ${id}`);
          continue;
        }

        await this.write(media);
        existingIds.add(id);
        downloaded++;
        await this.log(source, `OK wrote "${media.title}" (${media.category}, year=${media.year})`);
        await sleep(this.settings.requestDelayMs);
      } catch (error) {
        failed++;
        await this.log(source, `ERROR ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.log(source, `--- sync finished downloaded=${downloaded} discovered=${discovered} skipped=${skipped} failed=${failed} ---`);
    new Notice(`Sync complete: ${downloaded} notes written; ${discovered} new, ${skipped} skipped, ${failed} failed`);
  }

  private async fileLinks(source: TFile | null): Promise<SourceLink[]> {
    if (!source) throw new Error('Create JW Subtitle Sources.md or switch Sync source to Online categories');
    const text = (await this.app.vault.read(source)).split(/^## Sync log$/m, 1)[0];
    return sourceLinks(text);
  }

  private async onlineLinks(): Promise<SourceLink[]> {
    const links: SourceLink[] = [];
    for (const source of ONLINE_CATEGORIES) {
      if (!this.settings[source.enabled] || this.cancelling) continue;
      const html = (await requestUrl({ url: source.url })).text;
      const ids = extractIds(html);
      for (const id of ids) links.push({ url: directVideoUrl(id), category: source.category });
      await sleep(this.settings.requestDelayMs);
    }
    return links;
  }

  private async existingVideoIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const root = normalizePath(this.settings.rootFolder);
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${root}/`)) continue;
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter?.jwVideoId;
      if (typeof cached === 'string') ids.add(cached);
    }
    return ids;
  }

  async fetchMedia(id: string, link: SourceLink): Promise<MediaDetails | null> {
    const api = `https://b.jw-cdn.org/apis/mediator/v1/media-items/${encodeURIComponent(this.settings.language)}/${encodeURIComponent(id)}?clientType=www`;
    const data = (await requestUrl({ url: api })).json;
    const item = Array.isArray(data.media) ? data.media[0] || {} : {};
    const files = item.files || data.files || [];
    const candidates = files.flatMap((file: any) => [file.subtitles?.url, file.textTracks?.find((track: any) => track.src)?.src, file.tracks?.find((track: any) => track.src)?.src].filter(Boolean));
    if (!candidates.length) return null;

    const vtt = (await requestUrl({ url: candidates[0] })).text;
    if (!vtt) return null;

    const rawTitle = decodeHtml(item.title || link.title || id).trim();
    const category = link.category || categoryFor(link.url, item.categoryKey);
    const { title, speaker } = parseTitleAndSpeaker(rawTitle, category, id);
    return { id, title, speaker, year: parseYear(id, item.firstPublished, rawTitle), category, pageUrl: directVideoUrl(id), vtt };
  }

  async write(item: MediaDetails) {
    const folderName = folderFor(item.category);
    const root = normalizePath(this.settings.rootFolder);
    const categoryDir = normalizePath(`${root}/${folderName}`);
    const yearDir = normalizePath(`${categoryDir}/${item.year}`);
    await this.app.vault.createFolder(root).catch(() => undefined);
    await this.app.vault.createFolder(categoryDir).catch(() => undefined);
    await this.app.vault.createFolder(yearDir).catch(() => undefined);

    const filename = `${safe(item.title)}${item.speaker ? ` - ${safe(item.speaker)}` : ''} - ${shortId(item.id)}.md`;
    const path = normalizePath(`${yearDir}/${filename}`);
    const transcript = vttToParagraphs(item.vtt);
    const sections = this.settings.outputMode === 'vtt' ? `## Subtitles\n\n${item.vtt.trim()}` : this.settings.outputMode === 'plain' ? `## Transcript\n\n${transcript}` : `## Subtitles\n\n${item.vtt.trim()}\n\n## Transcript\n\n${transcript}`;
    const content = ['---', `jwVideoId: ${item.id}`, `title: ${JSON.stringify(item.title)}`, item.speaker ? `speaker: ${JSON.stringify(item.speaker)}` : undefined, `type: ${item.category}`, `year: ${item.year}`, `source: ${item.pageUrl}`, `outputMode: ${this.settings.outputMode}`, '---', '', `# ${item.title}`, item.speaker ? `\n**Speaker:** ${item.speaker}` : '', '', `Source: [JW.ORG](${item.pageUrl})`, '', sections, ''].filter((line): line is string => line !== undefined).join('\n');
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content); else await this.app.vault.create(path, content);
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, public plugin: JwSubtitlesPlugin) { super(app, plugin); }
  private async save() { await this.plugin.saveData(this.plugin.settings); }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('Root folder').addText(text => text.setValue(this.plugin.settings.rootFolder).onChange(async value => { this.plugin.settings.rootFolder = value || DEFAULT_SETTINGS.rootFolder; await this.save(); }));
    new Setting(this.containerEl).setName('Language code').addText(text => text.setValue(this.plugin.settings.language).onChange(async value => { this.plugin.settings.language = value.toUpperCase(); await this.save(); }));
    new Setting(this.containerEl).setName('Sync source').setDesc('Use a local source file or discover videos from the selected JW.ORG categories.').addDropdown(dropdown => dropdown.addOption('file', 'JW Subtitle Sources.md').addOption('online', 'Online categories (automatic)').setValue(this.plugin.settings.syncSource).onChange(async value => { this.plugin.settings.syncSource = value as SyncSource; await this.save(); this.display(); }));
    if (this.plugin.settings.syncSource === 'online') {
      new Setting(this.containerEl).setName('Broadcasting').setDesc('JW Broadcasting monthly programs.').addToggle(toggle => toggle.setValue(this.plugin.settings.onlineBroadcasting).onChange(async value => { this.plugin.settings.onlineBroadcasting = value; await this.save(); }));
      new Setting(this.containerEl).setName('Talks').setDesc('Studio talks and related video talks.').addToggle(toggle => toggle.setValue(this.plugin.settings.onlineTalks).onChange(async value => { this.plugin.settings.onlineTalks = value; await this.save(); }));
      new Setting(this.containerEl).setName('News Reports').setDesc('Governing Body Updates and other news reports.').addToggle(toggle => toggle.setValue(this.plugin.settings.onlineNewsReports).onChange(async value => { this.plugin.settings.onlineNewsReports = value; await this.save(); }));
      new Setting(this.containerEl).setName('Morning Worship').setDesc('Morning Worship programs.').addToggle(toggle => toggle.setValue(this.plugin.settings.onlineMorningWorship).onChange(async value => { this.plugin.settings.onlineMorningWorship = value; await this.save(); }));
    }
    new Setting(this.containerEl).setName('Output format').addDropdown(dropdown => dropdown.addOption('vtt', 'Raw VTT').addOption('plain', 'Formatted transcript').addOption('both', 'Raw VTT and formatted transcript').setValue(this.plugin.settings.outputMode).onChange(async value => { this.plugin.settings.outputMode = value as OutputMode; await this.save(); }));
  }
}

function sourceLinks(text: string): SourceLink[] {
  const links: SourceLink[] = [];
  for (const line of text.split(/\r?\n/)) {
    const markdown = line.match(/\[([^\]]+)\]\((https?:\/\/www\.jw\.org\/[^)]+)\)/i);
    if (markdown) links.push({ title: decodeHtml(markdown[1]).replace(/\s+/g, ' ').trim(), url: markdown[2] });
    else {
      const raw = line.match(/https?:\/\/www\.jw\.org\/[^\s)]+/i);
      if (raw) links.push({ url: raw[0] });
    }
  }
  return links;
}

function extractIds(value: string): string[] {
  const ids = new Set<string>();
  for (const match of value.matchAll(/(?:pub-jwb[a-z0-9_-]*|docid-\d+)_\d+_VIDEO/gi)) {
    ids.add(match[0]);
  }
  return [...ids];
}

function extractId(value: string): string | null { return extractIds(value)[0] || null; }
function directVideoUrl(id: string): string { return `https://www.jw.org/en/library/videos/?appLanguage=E&item=${encodeURIComponent(id)}`; }
function categoryFor(url: string, categoryKey?: string): Category {
  const value = `${url} ${categoryKey || ''}`;
  if (/StudioMonthlyPrograms/i.test(value)) return 'broadcasting';
  if (/StudioTalks/i.test(value)) return 'talks';
  if (/StudioNewsReports/i.test(value)) return 'news-reports';
  if (/VODPgmEvtMorningWorship/i.test(value)) return 'morning-worship';
  return 'other';
}
function folderFor(category: Category): string { return category === 'broadcasting' ? 'Broadcasting' : category === 'talks' ? 'Talks' : category === 'news-reports' ? 'News Reports' : category === 'morning-worship' ? 'Morning Worship' : 'Other'; }
function parseYear(id: string, firstPublished?: string, title?: string): number {
  if (firstPublished) { const year = new Date(firstPublished).getFullYear(); if (!Number.isNaN(year) && year > 1990) return year; }
  const titleYear = title?.match(/\b(?:19|20)\d{2}\b/); if (titleYear) return Number(titleYear[0]);
  const legacy = id.match(/^pub-jwb_(\d{4})/i); if (legacy) return Number(legacy[1]);
  return new Date().getFullYear();
}
function parseTitleAndSpeaker(rawTitle: string, category: Category, id: string): { title: string; speaker?: string } {
  let clean = rawTitle.replace(/\s+-\s+Library(?:\s+-\s+JW\.ORG)?$/i, '').replace(/\s+-\s+JW\.ORG(?:\s+Videos)?(?:\s+English)?$/i, '').replace(/\s+/g, ' ').trim();
  if (category === 'broadcasting') return { title: clean.replace(/^JW Broadcasting\s*[—-]\s*/i, '').trim() || id };
  const match = clean.match(/^([A-Z][A-Za-zÀ·Ö·Ø·ö·°·ÿ'\-.\s]+?):\s*(.+)$/);
  return match ? { speaker: match[1].trim(), title: match[2].trim() } : { title: clean || id };
}
function shortId(id: string): string { return id.replace(/^(?:pub|docid)-/, '').replace(/_VIDEO$/i, ''); }

interface Cue { start: number; end: number; text: string; speaker: boolean; }
function vttToParagraphs(vtt: string): string {
  const cues = parseVtt(vtt);
  const paragraphs: string[] = [];
  let current = '';
  let sentenceCount = 0;
  let previous: Cue | null = null;
  const flush = () => { const value = current.replace(/\s+/g, ' ').trim(); if (value) paragraphs.push(value); current = ''; sentenceCount = 0; };
  for (const cue of cues) {
    const pause = previous ? cue.start - previous.end : 0;
    const transition = cue.speaker || pause >= 2.5;
    const addition = cue.text;
    current = current ? `${current} ${addition}` : addition;
    if (/[.!?][”"']?$/.test(addition)) sentenceCount++;
    const completedThought = /[.!?][”"']?$/.test(addition);
    if (completedThought && (transition || sentenceCount >= 4 || current.length >= 700)) flush();
    previous = cue;
  }
  flush();
  return paragraphs.join('\n\n');
}
function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/^WEBVTT[^\n]*\n?/i, '').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) continue;
    const [from, to] = lines[index].split('-->');
    const text = decodeHtml(lines.slice(index + 1).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!text) continue;
    cues.push({ start: toSeconds(from), end: toSeconds(to.split(/\s+/)[0]), text, speaker: /^(?:[-–—]\s+|>>\s*)/.test(text) });
  }
  return cues;
}
function toSeconds(value: string): number { const parts = value.trim().replace(',', '.').split(':'); const seconds = Number(parts.pop() || 0); const minutes = Number(parts.pop() || 0); const hours = Number(parts.pop() || 0); return hours * 3600 + minutes * 60 + seconds; }
function decodeHtml(value: string): string { const element = document.createElement('textarea'); element.innerHTML = value; return element.value; }
function safe(value: string): string { return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180); }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

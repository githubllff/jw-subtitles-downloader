import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl, Platform } from 'obsidian';

type OutputMode = 'vtt' | 'plain' | 'both';
type Category = 'broadcasting' | 'talks' | 'news-reports' | 'morning-worship' | 'other';

interface Settings { rootFolder: string; language: string; requestDelayMs: number; outputMode: OutputMode; mobileOptimized: boolean; }
const DEFAULT_SETTINGS: Settings = { rootFolder: 'JW Subtitles', language: 'E', requestDelayMs: Platform.isMobile ? 1500 : 750, outputMode: 'both', mobileOptimized: true };
interface MediaDetails { id: string; title: string; speaker?: string; year: number; category: Category; pageUrl: string; vtt: string; }
interface SourceLink { url: string; title?: string; }
interface ExistingNote { id: string; title: string; category: Category; year: number; content: string; }

export default class JwSubtitlesPlugin extends Plugin {
  settings!: Settings;
  cancelling = false;
  statusBarEl: HTMLElement | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.statusBarEl = this.addStatusBarItem();
    this.addCommand({ id: 'sync', name: 'Sync JW subtitles', callback: () => this.sync() });
    this.addCommand({ id: 'cancel', name: 'Cancel JW subtitle sync', callback: () => { this.cancelling = true; this.updateStatus('Cancelled'); } });
    this.addCommand({ id: 'recategorize', name: 'Recategorize existing notes', callback: () => this.reorganizeExistingNotes() });
    this.addCommand({ id: 'reorganize-years', name: 'Reorganize notes by year', callback: () => this.reorganizeExistingNotes() });
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  onunload() { this.cancelling = true; }
  private updateStatus(message: string) { if (this.statusBarEl) this.statusBarEl.setText(message ? `JW Sync: ${message}` : ''); }
  private async log(source: TFile, message: string) { let text = await this.app.vault.read(source); if (!text.includes('## Sync log')) text += '\n\n## Sync log\n'; text += `- ${new Date().toISOString()} ${message}\n`; await this.app.vault.modify(source, text); }

  async reorganizeExistingNotes() {
    this.cancelling = false;
    const root = normalizePath(this.settings.rootFolder);
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${root}/`));
    if (!files.length) { new Notice('No JW Subtitles notes found'); return; }

    let moved = 0;
    let skipped = 0;
    let failed = 0;
    this.updateStatus(`Reorganizing 0/${files.length}`);

    for (let index = 0; index < files.length; index++) {
      if (this.cancelling) break;
      const file = files[index];
      this.updateStatus(`Reorganizing ${index + 1}/${files.length}`);
      try {
        const content = await this.app.vault.read(file);
        const note = parseExistingNote(content, file.basename);
        if (!note) { skipped++; continue; }

        const category = categoryFor('', '', note.id);
        const year = parseYear(note.id, undefined, note.title || file.basename);
        const expectedFolder = normalizePath(`${root}/${folderFor(category)}/${year}`);
        const expectedPath = normalizePath(`${expectedFolder}/${file.name}`);
        const updatedContent = updateFrontmatter(note.content, category, year);

        if (file.path === expectedPath) {
          if (updatedContent !== content) await this.app.vault.modify(file, updatedContent);
          skipped++;
          continue;
        }

        await this.app.vault.createFolder(expectedFolder).catch(() => undefined);
        await this.app.vault.modify(file, updatedContent);
        const collision = this.app.vault.getAbstractFileByPath(expectedPath);
        if (collision && collision !== file) {
          failed++;
          console.error(`Cannot move ${file.path}; destination already exists: ${expectedPath}`);
          continue;
        }
        await this.app.vault.rename(file, expectedPath);
        moved++;
      } catch (error) {
        failed++;
        console.error(`Failed to reorganize ${file.path}:`, error);
      }
    }

    const message = `Reorganize complete: ${moved} moved, ${skipped} already correct, ${failed} failed`;
    new Notice(message);
    this.updateStatus('Done');
    setTimeout(() => this.updateStatus(''), 5000);
  }

  async sync() {
    this.cancelling = false;
    const source = this.app.vault.getAbstractFileByPath('JW Subtitle Sources.md');
    if (!(source instanceof TFile)) { new Notice('Create JW Subtitle Sources.md with JW.ORG video URLs'); return; }
    this.updateStatus('Starting...');
    await this.log(source, '--- sync started ---');
    const text = (await this.app.vault.read(source)).split(/^## Sync log$/m, 1)[0];
    const links = sourceLinks(text);
    if (!links.length) { await this.log(source, 'No JW.ORG URLs found'); new Notice('No JW.ORG URLs found in JW Subtitle Sources.md'); this.updateStatus('No URLs found'); return; }

    let discovered = 0, downloaded = 0, skipped = 0, failed = 0;
    const seen = new Set<string>();
    for (let index = 0; index < links.length; index++) {
      if (this.cancelling) break;
      const link = links[index];
      this.updateStatus(`${index + 1}/${links.length}`);
      try {
        const id = extractId(link.url);
        if (!id || seen.has(id)) { skipped++; continue; }
        seen.add(id); discovered++;
        const media = await this.fetchMedia(id, link);
        if (!media) { skipped++; await this.log(source, `SKIP no VTT for ${id}`); continue; }
        await this.write(media); downloaded++;
        await this.log(source, `OK wrote "${media.title}" (${media.category}, year=${media.year})`);
        await sleep(this.settings.requestDelayMs);
      } catch (error) {
        failed++; const message = error instanceof Error ? error.message : String(error); await this.log(source, `ERROR ${message}`); console.error('JW Sync error:', error);
      }
    }
    await this.log(source, `--- sync finished downloaded=${downloaded} discovered=${discovered} skipped=${skipped} failed=${failed} ---`);
    new Notice(`Sync complete: ${downloaded} notes; ${discovered} discovered, ${skipped} skipped, ${failed} failed`);
    this.updateStatus(this.cancelling ? 'Cancelled' : 'Done'); setTimeout(() => this.updateStatus(''), 5000);
  }

  async fetchMedia(id: string, link: SourceLink): Promise<MediaDetails | null> {
    try {
      const api = `https://b.jw-cdn.org/apis/mediator/v1/media-items/${encodeURIComponent(this.settings.language)}/${encodeURIComponent(id)}?clientType=www`;
      const data = (await requestUrl({ url: api, throw: false })).json;
      const item = Array.isArray(data.media) ? data.media[0] || {} : {};
      const files = item.files || data.files || [];
      const candidates = files.flatMap((file: any) => [file.subtitles?.url, file.textTracks?.find((track: any) => track.src)?.src, file.tracks?.find((track: any) => track.src)?.src].filter(Boolean));
      if (!candidates.length) return null;
      const vtt = (await requestUrl({ url: candidates[0], throw: false })).text;
      if (!vtt) return null;
      const rawTitle = decodeHtml(item.title || link.title || id).trim();
      const category = categoryFor(link.url, item.categoryKey, id);
      const { title, speaker } = parseTitleAndSpeaker(rawTitle, category, id);
      return { id, title, speaker, year: parseYear(id, item.firstPublished, rawTitle), category, pageUrl: directVideoUrl(id), vtt };
    } catch (error) { console.error(`Failed to fetch ${id}:`, error); return null; }
  }

  async write(item: MediaDetails) {
    const root = normalizePath(this.settings.rootFolder);
    const categoryDir = normalizePath(`${root}/${folderFor(item.category)}`);
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
    new Setting(this.containerEl).setName('Root folder').setDesc('Where to store downloaded transcripts').addText(text => text.setValue(this.plugin.settings.rootFolder).onChange(async value => { this.plugin.settings.rootFolder = value || DEFAULT_SETTINGS.rootFolder; await this.save(); }));
    new Setting(this.containerEl).setName('Language code').setDesc('Subtitle language (E for English)').addText(text => text.setValue(this.plugin.settings.language).onChange(async value => { this.plugin.settings.language = value.toUpperCase(); await this.save(); }));
    if (Platform.isMobile) new Setting(this.containerEl).setName('Mobile optimized').setDesc('Slower sync to save battery and data').addToggle(toggle => toggle.setValue(this.plugin.settings.mobileOptimized).onChange(async value => { this.plugin.settings.mobileOptimized = value; this.plugin.settings.requestDelayMs = value ? 1500 : 750; await this.save(); }));
    new Setting(this.containerEl).setName('Output format').addDropdown(dropdown => dropdown.addOption('vtt', 'Raw VTT').addOption('plain', 'Formatted transcript').addOption('both', 'Raw VTT and formatted transcript').setValue(this.plugin.settings.outputMode).onChange(async value => { this.plugin.settings.outputMode = value as OutputMode; await this.save(); }));
  }
}

function parseExistingNote(content: string, fallbackTitle: string): ExistingNote | null {
  const id = content.match(/^jwVideoId:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
  if (!id) return null;
  const titleRaw = content.match(/^title:\s*(.+)$/m)?.[1]?.trim() || fallbackTitle;
  const title = titleRaw.replace(/^['"]|['"]$/g, '');
  return { id, title, category: 'other', year: new Date().getFullYear(), content };
}
function updateFrontmatter(content: string, category: Category, year: number): string {
  if (!content.startsWith('---\n')) return content;
  const set = (key: string, value: string) => new RegExp(`^${key}:\\s*.*$`, 'm').test(content) ? content.replace(new RegExp(`^${key}:\\s*.*$`, 'm'), `${key}: ${value}`) : content.replace(/^---\n/, `---\n${key}: ${value}\n`);
  content = set('type', category);
  return set('year', String(year));
}
function sourceLinks(text: string): SourceLink[] {
  const links: SourceLink[] = [];
  for (const line of text.split(/\r?\n/)) {
    const markdown = line.match(/\[([^\]]+)\]\((https?:\/\/www\.jw\.org\/[^)]+)\)/i);
    if (markdown) links.push({ title: decodeHtml(markdown[1]).replace(/\s+/g, ' ').trim(), url: markdown[2] });
    else { const raw = line.match(/https?:\/\/www\.jw\.org\/[^\s)]+/i); if (raw) links.push({ url: raw[0] }); }
  }
  return links;
}
function extractIds(value: string): string[] { const ids = new Set<string>(); for (const match of value.matchAll(/(?:pub-[a-z0-9_-]+|docid-\d+)_\d+_VIDEO/gi)) ids.add(match[0]); return [...ids]; }
function extractId(value: string): string | null { return extractIds(value)[0] || null; }
function directVideoUrl(id: string): string { return `https://www.jw.org/en/library/videos/?appLanguage=E&item=${encodeURIComponent(id)}`; }
function categoryFor(url: string, categoryKey?: string, id?: string): Category {
  if (/StudioMonthlyPrograms/i.test(url) || /StudioMonthlyPrograms/i.test(categoryKey || '')) return 'broadcasting';
  if (/StudioTalks/i.test(url) || /StudioTalks/i.test(categoryKey || '')) return 'talks';
  if (/StudioNewsReports/i.test(url) || /StudioNewsReports/i.test(categoryKey || '')) return 'news-reports';
  if (/VODPgmEvtMorningWorship/i.test(url) || /VODPgmEvtMorningWorship/i.test(categoryKey || '')) return 'morning-worship';
  if (/^pub-jwb-\d+_/i.test(id || '')) return 'broadcasting';
  if (/^pub-ivwc_/i.test(id || '')) return 'talks';
  if (/^pub-jwbvod/i.test(id || '') || /^docid-\d+_/i.test(id || '')) return 'news-reports';
  return 'other';
}
function folderFor(category: Category): string { return category === 'broadcasting' ? 'Broadcasting' : category === 'talks' ? 'Talks' : category === 'news-reports' ? 'News Reports' : category === 'morning-worship' ? 'Morning Worship' : 'Other'; }
function parseYear(id: string, firstPublished?: string, title?: string): number {
  if (firstPublished) { const year = new Date(firstPublished).getFullYear(); if (!Number.isNaN(year) && year > 1990) return year; }
  const match = title?.match(/\b(20\d{2}|19\d{2})\b/); if (match) return Number(match[1]);
  const legacy = id.match(/^pub-jwb_(\d{4})/i); if (legacy) return Number(legacy[1]);
  return new Date().getFullYear();
}
function parseTitleAndSpeaker(rawTitle: string, category: Category, id: string): { title: string; speaker?: string } {
  const clean = rawTitle.replace(/\s+-\s+Library(?:\s+-\s+JW\.ORG)?$/i, '').replace(/\s+-\s+JW\.ORG(?:\s+Videos)?(?:\s+English)?$/i, '').replace(/\s+/g, ' ').trim();
  if (category === 'broadcasting') return { title: clean.replace(/^JW Broadcasting\s*[—-]\s*/i, '').trim() || id };
  const match = clean.match(/^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'\-.\s]+?):\s*(.+)$/);
  return match ? { speaker: match[1].trim(), title: match[2].trim() } : { title: clean || id };
}
function shortId(id: string): string { return id.replace(/^(?:pub|docid)-/, '').replace(/_VIDEO$/i, ''); }

interface Cue { start: number; end: number; text: string; speaker: boolean; }
function vttToParagraphs(vtt: string): string {
  const cues = parseVtt(vtt); const paragraphs: string[] = []; let current = ''; let sentenceCount = 0; let previous: Cue | null = null;
  const flush = () => { const value = current.replace(/\s+/g, ' ').trim(); if (value) paragraphs.push(value); current = ''; sentenceCount = 0; };
  for (const cue of cues) { const pause = previous ? cue.start - previous.end : 0; const transition = cue.speaker || pause >= 2.5; current = current ? `${current} ${cue.text}` : cue.text; if (/[.!?][”"']?$/.test(cue.text)) sentenceCount++; if (/[.!?][”"']?$/.test(cue.text) && (transition || sentenceCount >= 4 || current.length >= 700)) flush(); previous = cue; }
  flush(); return paragraphs.join('\n\n');
}
function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/^WEBVTT[^\n]*\n?/i, '').split(/\r?\n\r?\n/)) { const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean); const index = lines.findIndex(line => line.includes('-->')); if (index < 0) continue; const [from, to] = lines[index].split('-->'); const text = decodeHtml(lines.slice(index + 1).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); if (text) cues.push({ start: toSeconds(from), end: toSeconds(to.split(/\s+/)[0]), text, speaker: /^(?:[-–—]\s+|>>\s*)/.test(text) }); }
  return cues;
}
function toSeconds(value: string): number { const parts = value.trim().replace(',', '.').split(':'); const seconds = Number(parts.pop() || 0); const minutes = Number(parts.pop() || 0); const hours = Number(parts.pop() || 0); return hours * 3600 + minutes * 60 + seconds; }
function decodeHtml(value: string): string { const element = document.createElement('textarea'); element.innerHTML = value; return element.value; }
function safe(value: string): string { return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180); }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

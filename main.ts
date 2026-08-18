import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl } from 'obsidian';

type OutputMode = 'vtt' | 'plain' | 'both';
type Category = 'broadcasting' | 'talks' | 'news-reports' | 'other';

interface Settings {
  rootFolder: string;
  language: string;
  requestDelayMs: number;
  outputMode: OutputMode;
}

const DEFAULT_SETTINGS: Settings = {
  rootFolder: 'JW Subtitles',
  language: 'E',
  requestDelayMs: 750,
  outputMode: 'both'
};

interface MediaDetails {
  id: string;
  title: string;
  speaker?: string;
  year: number;
  category: Category;
  pageUrl: string;
  vtt: string;
}

interface SourceLink {
  url: string;
  title?: string;
}

export default class JwSubtitlesPlugin extends Plugin {
  settings!: Settings;
  cancelling = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addCommand({
      id: 'sync',
      name: 'Sync JW subtitles',
      callback: () => this.sync()
    });
    this.addCommand({
      id: 'cancel',
      name: 'Cancel JW subtitle sync',
      callback: () => {
        this.cancelling = true;
      }
    });
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  private async log(source: TFile, message: string) {
    let text = await this.app.vault.read(source);
    if (!text.includes('## Sync log')) text += '\n\n## Sync log\n';
    text += `- ${new Date().toISOString()} ${message}\n`;
    await this.app.vault.modify(source, text);
  }

  async sync() {
    this.cancelling = false;
    const source = this.app.vault.getAbstractFileByPath('JW Subtitle Sources.md');
    if (!(source instanceof TFile)) {
      new Notice('Create JW Subtitle Sources.md with JW.ORG URLs first');
      return;
    }

    await this.log(source, '--- sync started ---');
    const sourceText = (await this.app.vault.read(source)).split(/^## Sync log$/m, 1)[0];
    const links = sourceLinks(sourceText);

    if (!links.length) {
      await this.log(source, 'No JW.ORG URLs found');
      new Notice('No JW.ORG URLs found');
      return;
    }

    let discovered = 0;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    const seen = new Set<string>();

    for (const link of links) {
      if (this.cancelling) break;
      try {
        const id = extractId(link.url);
        await this.log(source, `source=${link.url} extractedId=${id ?? '(none)'}`);

        if (!id || seen.has(id)) {
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
        downloaded++;
        await this.log(source, `OK wrote "${media.title}" (${media.category}, year=${media.year})`);
        await sleep(this.settings.requestDelayMs);
      } catch (error) {
        failed++;
        await this.log(source, `ERROR ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.log(source, `--- sync finished downloaded=${downloaded} discovered=${discovered} skipped=${skipped} failed=${failed} ---`);
    new Notice(`Sync complete: ${downloaded} notes written; ${discovered} discovered, ${skipped} skipped, ${failed} failed`);
  }

  async fetchMedia(id: string, link: SourceLink): Promise<MediaDetails | null> {
    const api = `https://b.jw-cdn.org/apis/mediator/v1/media-items/${encodeURIComponent(this.settings.language)}/${encodeURIComponent(id)}?clientType=www`;
    const res = await requestUrl({ url: api });
    const data = res.json;

    const mediaList = Array.isArray(data.media) ? data.media : [];
    const item = mediaList[0] || {};
    const files = item.files || data.files || [];

    const candidateUrls = files.flatMap((f: any) => [
      f.subtitles?.url,
      f.textTracks?.find((t: any) => t.src)?.src,
      f.tracks?.find((t: any) => t.src)?.src
    ]).filter(Boolean);

    if (!candidateUrls.length) return null;

    const vttRes = await requestUrl({ url: candidateUrls[0] });
    const vtt = vttRes.text;
    if (!vtt) return null;

    const rawTitle = decodeHtml(item.title || link.title || id).trim();
    const category = categoryFor(link.url, item.categoryKey);
    const date = parseDate(id, item.firstPublished, rawTitle);
    const { title, speaker } = parseTitleAndSpeaker(rawTitle, category, id);

    return {
      id,
      title,
      speaker,
      year: date.year,
      category,
      pageUrl: directVideoUrl(id),
      vtt
    };
  }

  async write(item: MediaDetails) {
    const folderName = item.category === 'talks'
      ? 'Talks'
      : item.category === 'news-reports'
      ? 'News Reports'
      : item.category === 'broadcasting'
      ? 'Broadcasting'
      : 'Other';

    const root = normalizePath(this.settings.rootFolder);
    const categoryDir = normalizePath(`${root}/${folderName}`);
    const yearDir = normalizePath(`${categoryDir}/${item.year}`);

    await this.app.vault.createFolder(root).catch(() => undefined);
    await this.app.vault.createFolder(categoryDir).catch(() => undefined);
    await this.app.vault.createFolder(yearDir).catch(() => undefined);

    const speakerPart = item.speaker ? ` - ${safe(item.speaker)}` : '';
    const filename = `${safe(item.title)}${speakerPart} - ${shortId(item.id)}.md`;
    const path = normalizePath(`${yearDir}/${filename}`);

    const plain = vttToPlain(item.vtt);
    const sections = this.settings.outputMode === 'vtt'
      ? `## Subtitles\n\n${item.vtt.trim()}`
      : this.settings.outputMode === 'plain'
      ? `## Transcript\n\n${plain}`
      : `## Subtitles\n\n${item.vtt.trim()}\n\n## Transcript\n\n${plain}`;

    const content = [
      '---',
      `jwVideoId: ${item.id}`,
      `title: ${JSON.stringify(item.title)}`,
      item.speaker ? `speaker: ${JSON.stringify(item.speaker)}` : undefined,
      `type: ${item.category}`,
      `year: ${item.year}`,
      `source: ${item.pageUrl}`,
      `outputMode: ${this.settings.outputMode}`,
      '---',
      '',
      `# ${item.title}`,
      item.speaker ? `\n**Speaker:** ${item.speaker}` : '',
      '',
      `Source: [JW.ORG](${item.pageUrl})`,
      '',
      sections,
      ''
    ].filter((line): line is string => line !== undefined).join('\n');

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(path, content);
    }
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, public plugin: JwSubtitlesPlugin) {
    super(app, plugin);
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName('Root folder')
      .addText(t => t
        .setValue(this.plugin.settings.rootFolder)
        .onChange(async v => {
          this.plugin.settings.rootFolder = v || DEFAULT_SETTINGS.rootFolder;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(this.containerEl)
      .setName('Language code')
      .addText(t => t
        .setValue(this.plugin.settings.language)
        .onChange(async v => {
          this.plugin.settings.language = v.toUpperCase();
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(this.containerEl)
      .setName('Output format')
      .addDropdown(d => d
        .addOption('vtt', 'Raw VTT')
        .addOption('plain', 'Plain transcript')
        .addOption('both', 'Raw VTT and plain transcript')
        .setValue(this.plugin.settings.outputMode)
        .onChange(async v => {
          this.plugin.settings.outputMode = v as OutputMode;
          await this.plugin.saveData(this.plugin.settings);
        }));
  }
}

function sourceLinks(text: string): SourceLink[] {
  const links: SourceLink[] = [];
  for (const line of text.split(/\r?\n/)) {
    const markdown = line.match(/\[([^\]]+)\]\((https?:\/\/www\.jw\.org\/[^)]+)\)/i);
    if (markdown) {
      links.push({ title: decodeHtml(markdown[1]).replace(/\s+/g, ' ').trim(), url: markdown[2] });
    } else {
      const raw = line.match(/https?:\/\/www\.jw\.org\/[^\s)]+/i);
      if (raw) links.push({ url: raw[0] });
    }
  }
  return links;
}

function categoryFor(url: string, categoryKey?: string): Category {
  const combined = `${url} ${categoryKey || ''}`;
  if (/StudioMonthlyPrograms/i.test(combined)) return 'broadcasting';
  if (/StudioTalks/i.test(combined)) return 'talks';
  if (/StudioNewsReports/i.test(combined)) return 'news-reports';
  return 'other';
}

function directVideoUrl(id: string): string {
  return `https://www.jw.org/en/library/videos/?appLanguage=E&item=${encodeURIComponent(id)}`;
}

function extractId(value: string): string | null {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {}
  const direct = decoded.match(/(?:^|[/?#=&])(pub-[A-Za-z0-9_-]+)(?=$|[/?#&])/i)?.[1];
  if (direct) return direct;
  try {
    const url = new URL(value);
    for (const part of [url.searchParams.get('lank'), url.searchParams.get('docid'), url.searchParams.get('item')]) {
      const match = part?.match(/pub-[A-Za-z0-9_-]+/i);
      if (match) return match[0];
    }
  } catch {}
  return null;
}

function parseDate(id: string, firstPublished?: string, title?: string): { year: number } {
  const titleYear = title?.match(/\b(20\d{2}|19\d{2})\b/);
  if (titleYear) return { year: Number(titleYear[1]) };

  if (firstPublished) {
    const parsed = new Date(firstPublished).getFullYear();
    if (!Number.isNaN(parsed) && parsed > 1990) return { year: parsed };
  }

  const legacy = id.match(/^pub-jwb_(\d{4})/i);
  if (legacy) return { year: Number(legacy[1]) };

  return { year: new Date().getFullYear() };
}

function parseTitleAndSpeaker(rawTitle: string, category: Category, id: string): { title: string; speaker?: string } {
  let clean = rawTitle
    .replace(/\s+-\s+Library(?:\s+-\s+JW\.ORG)?$/i, '')
    .replace(/\s+-\s+JW\.ORG(?:\s+Videos)?(?:\s+English)?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (category === 'broadcasting') {
    clean = clean.replace(/^JW Broadcasting\s*[—-]\\s*/i, '').trim();
    return { title: clean || id };
  }

  const speakerColonMatch = clean.match(/^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'\-.\s]+?):\s*(.+)$/);
  if (speakerColonMatch) {
    return {
      speaker: speakerColonMatch[1].trim(),
      title: speakerColonMatch[2].trim()
    };
  }

  if (category === 'talks') {
    const speakerDashMatch = clean.match(/^(.+?)\s*[—-]\\s*([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'\-.\s]+)$/);
    if (speakerDashMatch) {
      return {
        title: speakerDashMatch[1].trim(),
        speaker: speakerDashMatch[2].trim()
      };
    }
  }

  return { title: clean || id };
}

function shortId(id: string): string {
  return id.replace(/^pub-/, '').replace(/_VIDEO$/i, '');
}

function vttToPlain(vtt: string): string {
  return vtt.split(/\r?\n\r?\n/).map(block => {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length || lines[0].toUpperCase() === 'WEBVTT') return '';
    const timeIndex = lines.findIndex(line => line.includes('-->'));
    const textLines = timeIndex >= 0 ? lines.slice(timeIndex + 1) : lines;
    return textLines.join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = value;
  return el.value;
}

function safe(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

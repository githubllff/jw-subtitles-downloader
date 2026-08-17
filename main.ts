import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl } from 'obsidian';

interface Settings { rootFolder: string; language: string; requestDelayMs: number; }
const DEFAULT_SETTINGS: Settings = { rootFolder: 'JW Subtitles', language: 'E', requestDelayMs: 750 };
interface Item { id: string; title: string; year: number; pageUrl: string; }

export default class JwSubtitlesPlugin extends Plugin {
 settings!: Settings; cancelling = false;
 async onload() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  this.addCommand({id:'sync',name:'Sync JW subtitles',callback:()=>this.sync()});
  this.addCommand({id:'cancel',name:'Cancel JW subtitle sync',callback:()=>{this.cancelling=true;}});
  this.addSettingTab(new SettingsTab(this.app,this)); }
 async sync() { this.cancelling=false; const source=this.app.vault.getAbstractFileByPath('JW Subtitle Sources.md'); if (!(source instanceof TFile)) { new Notice('Create JW Subtitle Sources.md with JW.ORG URLs first'); return; }
  const urls=[...(await this.app.vault.read(source)).matchAll(/https?:\\/\\/www\\.jw\\.org\\/[^\\s)]+/gi)].map(m=>m[0]); let count=0;
  for (const url of urls) { if(this.cancelling) break; const html=(await requestUrl({url})).text; const id=extractId(html)||extractId(url); if(!id) continue; const year=Number(url.match(/\\/(\\d{4})-/)?.[1]||new Date().getFullYear()); const title=meta(html,'og:title')||id; const vtt=await this.download(id); if(!vtt) continue; await this.write({id,title,year,pageUrl:url},vtt); count++; await sleep(this.settings.requestDelayMs); }
  new Notice(this.cancelling?`Cancelled after ${count} notes`:`Created ${count} notes`); }
 async download(id:string):Promise<string|null> { const api=`https://b.jw-cdn.org/apis/mediator/v1/media-items/${encodeURIComponent(this.settings.language)}/${encodeURIComponent(id)}?clientType=www`; const data=(await requestUrl({url:api})).json; const files=data.media?.[0]?.files||[]; const track=files.find((f:any)=>f.subtitles?.url)?.subtitles?.url; return track?(await requestUrl({url:track})).text:null; }
 async write(item:Item,vtt:string) { const folder=normalizePath(`${this.settings.rootFolder}/${item.year}`); await this.app.vault.createFolder(this.settings.rootFolder).catch(()=>{}); await this.app.vault.createFolder(folder).catch(()=>{}); const path=normalizePath(`${folder}/${safe(item.title)}.md`); const text=`---\njwVideoId: ${item.id}\ntitle: ${JSON.stringify(item.title)}\nyear: ${item.year}\nsource: ${item.pageUrl}\n---\n\n# ${item.title}\n\nSource: [JW.ORG](${item.pageUrl})\n\n## Subtitles\n\n${vtt.trim()}\n`; const old=this.app.vault.getAbstractFileByPath(path); if(old instanceof TFile) await this.app.vault.modify(old,text); else await this.app.vault.create(path,text); }
}
class SettingsTab extends PluginSettingTab { constructor(app:App,public plugin:JwSubtitlesPlugin){super(app,plugin);} display(){this.containerEl.empty(); new Setting(this.containerEl).setName('Root folder').addText(t=>t.setValue(this.plugin.settings.rootFolder).onChange(async v=>{this.plugin.settings.rootFolder=v||DEFAULT_SETTINGS.rootFolder;await this.plugin.saveData(this.plugin.settings);})); new Setting(containerEl).setName('Language code').addText(t=>t.setValue(this.plugin.settings.language).onChange(async v=>{this.plugin.settings.language=v.toUpperCase();await this.plugin.saveData(this.plugin.settings);}));} }
function extractId(s:string){return s.match(/pub-[A-Za-z0-9_-]+/)?.[0]||null;} function meta(h:string,p:string){return h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)`,'i'))?.[1]||'';} function safe(s:string){return s.replace(/[\\/:*?"<>|]/g,'-').replace(/\\s+/g,' ').trim().slice(0,180);} function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}

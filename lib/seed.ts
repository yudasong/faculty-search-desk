import directory from './directory.json';
import examples from './discovered-openings.json';
import type { DeskData, School } from './types';
const schools:School[]=directory.schools.map(raw=>{
 const sources=raw.departments.flatMap(d=>d.sources.map(x=>({department:d.code,url:x.url,note:'Official hiring hub; verify each current opening.',checkedAt:x.verifiedAt})));
 let domain='';try{const h=new URL(sources[0]?.url||'').hostname;domain=h.endsWith('.edu')?h.split('.').slice(-2).join('.'):''}catch{}
 const ranks:any[]=raw.rankingMemberships;
 return {id:raw.id,name:raw.name,shortName:raw.name.replace(/^University of /,'').replace(/ University$/,''),country:raw.country,location:raw.city+', '+raw.state,domain,considering:false,departments:raw.departments.map(d=>d.code),sources,notes:'',origin:'Public research directory',rankingNote:ranks.map(r=>`${r.source} #${r.rank}: ${r.scope||''}; ${r.period||r.year||r.edition||''}. ${r.note||r.caveat||''}`).join(' '),rankingSources:ranks.map(r=>({name:r.source,url:r.url,rank:r.rank,year:r.period||r.year||r.edition||r.asOf||'2026'}))};
});
export const seed:DeskData={schools,openings:examples.map(o=>({...o,workflow:'Inbox',notes:''})),requests:[],runs:[],settings:{scope:'Tenure-track assistant professor; all CS areas and related ECE/EECS searches.',rankingRule:'Union of top-50 US CS departments across credible rankings; keep source, year, ties and method. Initial directory is a September 2026 snapshot, not an exhaustive union.',schedule:'On demand only. Use Search now to check sources and discover openings.'}};

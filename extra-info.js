/* Preserve app-injected context outside the visible text part list. No unmarked text is removed. */
(function(root){
'use strict';
const KEY='watermelon_bridge_extra_info_v1';
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>!!o&&typeof o==='object'&&!Array.isArray(o);
function isInjected(p){return p?.type==='text'&&object(p.metadata)&&p.metadata.orangechat_extra_info===true&&typeof p.text==='string'&&/^<extra_info_context>[\s\S]*<\/extra_info_context>$/.test(p.text)}
function digest(parts){const s=JSON.stringify(parts);let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return s.length+':'+(h>>>0).toString(16)}
function transformMessage(message,target){
 const counts={hidden:0,restored:0,skipped:0};
 if(message.role!=='user'||!Array.isArray(message.parts))return {message,counts};
 const parts=message.parts, anchors=parts.map((p,i)=>object(p.metadata)&&own(p.metadata,KEY)?i:-1).filter(i=>i>=0);
 if(target==='kira'){
  if(!anchors.length)return {message,counts};
  if(anchors.length!==1){counts.skipped++;return {message,counts}}
  const ai=anchors[0],saved=parts[ai].metadata[KEY];
  const bad=()=>{counts.skipped++;return {message,counts}};
  if(!object(saved)||saved.version!==1||saved.messageId!==message.id||!Array.isArray(saved.entries)||!saved.entries.length||saved.originalCount!==parts.length+saved.entries.length)return bad();
  const restoredAnchor={...parts[ai]},meta={...restoredAnchor.metadata};delete meta[KEY];
  if(saved.anchorMetadata==='absent'){if(Object.keys(meta).length)return bad();delete restoredAnchor.metadata}
  else if(saved.anchorMetadata==='null'){if(Object.keys(meta).length)return bad();restoredAnchor.metadata=null}
  else if(saved.anchorMetadata==='object')restoredAnchor.metadata=meta;else return bad();
  const clean=parts.map((p,i)=>i===ai?restoredAnchor:p);
  if(digest(clean)!==saved.keptDigest)return bad();
  const indices=new Set();let previous=-1;
  for(const e of saved.entries){if(!object(e)||!Number.isInteger(e.index)||e.index<=previous||e.index<0||e.index>=saved.originalCount||!isInjected(e.part)||indices.has(e.index))return bad();indices.add(e.index);previous=e.index}
  const result=[];let ri=0,ki=0;
  for(let i=0;i<saved.originalCount;i++)result.push(saved.entries[ri]?.index===i?saved.entries[ri++].part:clean[ki++]);
  if(ki!==clean.length||ri!==saved.entries.length)return bad();
  counts.restored=saved.entries.length;return {message:{...message,parts:result},counts};
 }
 if(target!=='shaoye')return {message,counts};
 const entries=parts.map((part,index)=>({part,index})).filter(e=>isInjected(e.part));
 if(!entries.length)return {message,counts};
 if(anchors.length){counts.skipped+=entries.length;return {message,counts}}
 const kept=parts.filter(p=>!isInjected(p));
 // Never turn an otherwise empty message into an invisible or invalid one.
 if(!kept.length){counts.skipped+=entries.length;return {message,counts}}
 const anchor=kept[0];if(anchor.metadata!=null&&!object(anchor.metadata)){counts.skipped+=entries.length;return {message,counts}}
 const saved={version:1,messageId:message.id,originalCount:parts.length,anchorMetadata:!own(anchor,'metadata')?'absent':anchor.metadata===null?'null':'object',keptDigest:digest(kept),entries};
 const newAnchor={...anchor,metadata:{...(anchor.metadata||{}),[KEY]:saved}};
 counts.hidden=entries.length;return {message:{...message,parts:[newAnchor,...kept.slice(1)]},counts};
}
function transformMessages(raw,target){
 const parsed=JSON.parse(raw),counts={hidden:0,restored:0,skipped:0};let changed=false;
 const messages=parsed.map(m=>{const r=transformMessage(m,target);if(r.message!==m)changed=true;for(const k of Object.keys(counts))counts[k]+=r.counts[k];return r.message});
 return {raw:changed?JSON.stringify(messages):raw,counts};
}
root.WatermelonExtraInfo={KEY,isInjected,transformMessage,transformMessages};
if(typeof module!=='undefined')module.exports=root.WatermelonExtraInfo;
})(typeof self!=='undefined'?self:globalThis);

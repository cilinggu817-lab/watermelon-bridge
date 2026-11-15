/* Local-only RikkaHub backup adapter, scoped to the two inspected schema-43 builds. */
(function (root) {
'use strict';
const extraInfo=typeof module!=='undefined'?require('./extra-info.js'):root.WatermelonExtraInfo;
const enc=new TextEncoder(), dec=new TextDecoder();
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const MAX=450*1024*1024;
function fail(s){throw new Error(s)}
function rows(db,sql,args=[]){const st=db.prepare(sql);const out=[];try{st.bind(args);while(st.step())out.push(st.getAsObject())}finally{st.free()}return out}
function scalar(db,sql){return db.exec(sql)[0]?.values[0][0]}
function checksum(bytes,little,a=0,b=0){const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<bytes.length;i+=8){a=(a+d.getUint32(i,little)+b)>>>0;b=(b+d.getUint32(i+4,little)+a)>>>0}return [a,b]}
function mergeWal(main,wal){
 if(main.length<100||dec.decode(main.subarray(0,16))!=='SQLite format 3\0')fail('备份中的数据库不是有效的 SQLite 文件。');
 let out=main.slice(), frames=0, trailing=false;
 if(wal?.length){
  if(wal.length<32)fail('WAL 日志头不完整，无法安全恢复备份。');
  const v=new DataView(wal.buffer,wal.byteOffset,wal.byteLength), magic=v.getUint32(0), little=magic===0x377f0682;
  if(magic!==0x377f0682&&magic!==0x377f0683)fail('WAL 日志格式无法识别。');
  if(v.getUint32(4)!==3007000)fail('不支持此 WAL 日志版本。');
  let ps=v.getUint32(8);if(ps===1)ps=65536;
  const mainPs=(main[16]<<8|main[17])===1?65536:(main[16]<<8|main[17]);
  if(ps!==mainPs||ps<512||ps>65536||(ps&(ps-1)))fail('数据库与 WAL 日志的页面大小不匹配。');
  let [a,b]=checksum(wal.subarray(0,24),little);if(a!==v.getUint32(24)||b!==v.getUint32(28))fail('WAL 日志头校验失败。');
  const list=[];let last=-1,size=0;
  for(let o=32;o+24+ps<=wal.length;o+=24+ps){
   if(v.getUint32(o+8)!==v.getUint32(16)||v.getUint32(o+12)!==v.getUint32(20)){trailing=true;break}
   [a,b]=checksum(wal.subarray(o,o+8),little,a,b);[a,b]=checksum(wal.subarray(o+24,o+24+ps),little,a,b);
   if(a!==v.getUint32(o+16)||b!==v.getUint32(o+20))fail('WAL 日志帧校验失败，请重新导出备份。');
   const pg=v.getUint32(o),n=v.getUint32(o+4);if(!pg||pg*ps>MAX||n*ps>MAX)fail('WAL 页面范围异常或备份过大。');
   list.push({pg,o});if(n){last=list.length-1;size=n*ps}
  }
  trailing=trailing||((wal.length-32)%(ps+24)!==0);
  if(last>=0){out=new Uint8Array(size);out.set(main.subarray(0,size));for(let i=0;i<=last;i++){const {pg,o}=list[i];if(pg*ps<=size)out.set(wal.subarray(o+24,o+24+ps),(pg-1)*ps)}frames=last+1}
 }
 out[18]=1;out[19]=1;return {bytes:out,frames,trailing};
}
function unpack(bytes,zip){let total=0;const seen=new Set();return zip.unzipSync(bytes,{filter(f){if(seen.has(f.name))fail('ZIP 中有重名文件，已停止转换。');seen.add(f.name);if(f.name.startsWith('/')||f.name.includes('\\')||f.name.split('/').includes('..'))fail('ZIP 内含不安全的文件路径。');total+=f.originalSize;if(total>MAX||f.originalSize>MAX)fail('解压后超过 450 MB，当前手机网页暂不支持。');return true}})}
function inspect(bytes,SQL,zip,profiles){
 const files=unpack(bytes,zip);if(!files['rikka_hub.db']||!files['settings.json'])fail('请选择 App 导出的完整备份 ZIP（内含 settings.json 和 rikka_hub.db）。');
 const merged=mergeWal(files['rikka_hub.db'],files['rikka_hub-wal']);const db=new SQL.Database(merged.bytes);
 try{
 const ver=scalar(db,'PRAGMA user_version'),ident=scalar(db,'SELECT identity_hash FROM room_master_table WHERE id=42');
 const flavor=Object.keys(profiles).find(k=>profiles[k].identity===ident&&profiles[k].version===ver);
 if(!flavor)fail('这份备份不属于已适配的少夜版 / Kira 版。请先适配这个版本，不能只按数据库版本号强转。');
 const profile=profiles[flavor];
 for(const [name,expected] of Object.entries(profile.columns)){
  const actual=rows(db,'PRAGMA table_info('+qi(name)+')');
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('数据库结构与已适配版本不同：'+name+'。已停止转换以保护数据。');
 }
 const known=new Set(profile.schemas.map(x=>x.name));
 const extra=rows(db,"SELECT name FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").filter(r=>!known.has(r.name));
 if(extra.length)fail('发现此版本新增的数据表或索引，需更新适配后再转换。');
 const settings=JSON.parse(dec.decode(files['settings.json']));if(!settings||Array.isArray(settings)||typeof settings!=='object')fail('设置文件格式不正确。');
 const counts={conversations:scalar(db,'SELECT count(*) FROM ConversationEntity'),nodes:scalar(db,'SELECT count(*) FROM message_node'),messages:0,attachments:Object.keys(files).filter(n=>/^(upload|voice_messages|images|files)\//.test(n)&&!n.endsWith('/')).length,missingMedia:0,assistants:settings.assistants?.length||0,providers:settings.providers?.length||0};
 const missing=new Set();
 for(const r of rows(db,'SELECT messages FROM message_node')){const ms=JSON.parse(r.messages);if(!Array.isArray(ms))fail('聊天消息格式异常。');counts.messages+=ms.length;for(const m of ms)for(const p of m.parts||[]){const u=p.url;if(typeof u==='string'&&u.startsWith('file:')){const match=u.match(/\/files\/(.+)$/);if(match&&!files[decodeURIComponent(match[1])])missing.add(match[1])}}}
 counts.missingMedia=missing.size;
 return {files,db,settings,flavor,profile,counts,walFrames:merged.frames,walTrailing:merged.trailing};
 }catch(e){db.close();throw e}
}
function put(db,table,cols,values){if(!cols.length)return;const st=db.prepare('INSERT INTO '+qi(table)+' ('+cols.map(qi).join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');try{for(const row of values)st.run(row)}finally{st.free()}}
function validateNodes(db){
 const orphan=scalar(db,'SELECT count(*) FROM message_node n LEFT JOIN ConversationEntity c ON c.id=n.conversation_id WHERE c.id IS NULL');if(orphan)fail('发现没有所属会话的消息，已停止转换。');
 for(const r of rows(db,'SELECT messages,select_index FROM message_node')){const m=JSON.parse(r.messages);if(!Array.isArray(m)||m.length===0||r.select_index<0||r.select_index>=m.length)fail('发现无效的消息分支选择，已停止转换。')}
}
function convert(state,target,SQL,zip,profiles,progress=()=>{}){
 if(target===state.flavor)fail('当前备份已经是所选版本。');if(!profiles[target])fail('请选择目标版本。');
 const {db:src,profile:sp,files}=state,tp=profiles[target],dst=new SQL.Database();
 const report={format:'watermelon-bridge-report-v1',source:sp.label,target:tp.label,createdAt:new Date().toISOString(),counts:state.counts,walFrames:state.walFrames,missingMedia:state.counts.missingMedia,preservedTables:[],preservedColumns:{},extraInfo:{hidden:0,restored:0,skipped:0},notes:[]};
 try{
 progress('核对消息与分支');validateNodes(src);
 dst.run('PRAGMA foreign_keys=OFF; BEGIN');
 // Create ordinary tables including FTS shadow storage. The unchanged FTS index is copied byte-for-byte.
 for(const r of tp.schemas)if(r.type==='table'&&r.name!=='message_fts')dst.run(r.sql);
 const aliases={message_fts_lookup:'message_fts_rowid',message_fts_rowid:'message_fts_lookup'};
 const tableNames=Object.keys(tp.columns);
 for(let ti=0;ti<tableNames.length;ti++){
  const name=tableNames[ti];if(name==='room_master_table')continue;
  let sourceName=sp.columns[name]?name:aliases[name];if(!sourceName||!sp.columns[sourceName])continue;
  progress('转换数据 '+(ti+1)+' / '+tableNames.length);
  const sourceCols=sp.columns[sourceName].map(c=>c.name), targetCols=tp.columns[name],common=targetCols.filter(c=>sourceCols.includes(c.name)).map(c=>c.name);
  const required=targetCols.filter(c=>!common.includes(c.name)&&c.notnull&&c.dflt_value===null);
  const cols=[...common,...required.map(c=>c.name)];
  const read=src.prepare('SELECT '+common.map(qi).join(',')+' FROM '+qi(sourceName));
  const write=dst.prepare('INSERT INTO '+qi(name)+' ('+cols.map(qi).join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');
  try{while(read.step()){
   const r=read.getAsObject();
   if(name==='message_node'){
    const mapped=extraInfo.transformMessages(r.messages,target);r.messages=mapped.raw;
    for(const k of Object.keys(report.extraInfo))report.extraInfo[k]+=mapped.counts[k];
   }
   write.run(cols.map(k=>{
    if(common.includes(k))return r[k];
    if(name==='usage_record'&&k==='total_tokens')return (r.prompt_tokens||0)+(r.completion_tokens||0);
    if(name==='usage_record'&&k==='usage_reported')return (r.prompt_tokens||0)+(r.completion_tokens||0)>0?1:0;
    if(name==='usage_record'&&k==='outcome')return 'SUCCESS';
    fail('缺少必需字段映射：'+name+'.'+k);
   }));
  }}finally{read.free();write.free()}

 }
 put(dst,'room_master_table',['id','identity_hash'],[[42,tp.identity]]);
 // Preserve AUTOINCREMENT high-water marks, including deleted records.
 if(scalar(src,"SELECT count(*) FROM sqlite_master WHERE name='sqlite_sequence'")){
  for(const r of rows(src,'SELECT name,seq FROM sqlite_sequence'))if(tp.columns[r.name]){
   const current=rows(dst,'SELECT seq FROM sqlite_sequence WHERE name=?',[r.name]);
   if(current.length)dst.run('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?',[r.seq,r.name]);else dst.run('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)',[r.name,r.seq]);
  }
 }
 for(const r of tp.schemas)if(r.type==='index')dst.run(r.sql);
 for(const r of tp.schemas)if(r.type==='trigger'||r.type==='view')dst.run(r.sql);
 dst.run('PRAGMA user_version='+tp.version+'; COMMIT');
 for(const name of Object.keys(sp.columns)){
  if(!tp.columns[name]&&!aliases[name]&&!name.startsWith('message_fts')){const count=scalar(src,'SELECT count(*) FROM '+qi(name));if(count)report.preservedTables.push({name,rows:count})}
  else if(tp.columns[name]){const extras=sp.columns[name].map(c=>c.name).filter(k=>!tp.columns[name].some(c=>c.name===k));if(extras.length)report.preservedColumns[name]=extras}
 }
 progress('校验聊天与数据库');validateNodes(dst);
 const fk=rows(dst,'PRAGMA foreign_key_check');if(fk.length)fail('目标数据库外键校验未通过，已停止生成。');
 const integrity=scalar(dst,'PRAGMA integrity_check');if(integrity!=='ok')fail('数据库完整性校验失败。');
 for(const n of ['ConversationEntity','message_node','MemoryEntity','message_reaction'])if(sp.columns[n]&&tp.columns[n]){
  if(scalar(src,'SELECT count(*) FROM '+qi(n))!==scalar(dst,'SELECT count(*) FROM '+qi(n)))fail('数据条数校验失败：'+n);
 }
 const before=src.prepare('SELECT id,messages,select_index FROM message_node ORDER BY id'),after=dst.prepare('SELECT id,messages,select_index FROM message_node ORDER BY id');
 try{while(before.step()){if(!after.step())fail('消息数量校验失败。');const a=before.get(),b=after.get();a[1]=extraInfo.transformMessages(a[1],target).raw;if(a.some((x,i)=>x!==b[i]))fail('消息内容或分支校验失败。')}if(after.step())fail('消息数量校验失败。')}finally{before.free();after.free()}
 // Both apps use the same FTS5 simple index format. Retain its opaque index blocks and original declaration.
 const ft=tp.schemas.find(x=>x.name==='message_fts');
 if(ft){dst.run('PRAGMA writable_schema=ON');dst.run("INSERT INTO sqlite_master(type,name,tbl_name,rootpage,sql) VALUES ('table','message_fts','message_fts',0,?)",[ft.sql]);dst.run('PRAGMA writable_schema=OFF');}
 const exported=dst.export();const check=new SQL.Database(exported);
 try{if(scalar(check,'SELECT count(*) FROM message_node')!==state.counts.nodes)fail('导出文件复核失败。');if(scalar(check,'SELECT identity_hash FROM room_master_table WHERE id=42')!==tp.identity)fail('目标版本标识校验失败。')}finally{check.close()}
 report.notes.push('消息已按已声明的背景信息兼容规则逐条核对；用户原话、模型回复、分支与选择均保留。','设置文件和插件文件按原样保留；对方版本不支持的选项可能被 App 忽略。','两版压缩方式不同，目标压缩状态设为空；原摘要可通过另存原始留存包保留。','本工具转换备份格式，不会合并目标 App 内已有聊天。','此结果通过文件级校验，仍需在对应 Android App 中实际导入验证。');
 if(state.counts.missingMedia)report.notes.push('原备份缺少 '+state.counts.missingMedia+' 个本地媒体文件，转换无法补齐。');
 if(report.preservedTables.length||Object.keys(report.preservedColumns).length)report.notes.push('请另存原始留存包以保存独有数据；当前版本不会自动把独有数据合并回另一份备份。');
 if(target==='shaoye')report.notes.push('Kira 用量记录没有结果状态；转入少夜版时按 SUCCESS 补齐，total_tokens 按输入加输出计算，实际历史状态无法还原。');
 if(report.extraInfo.hidden)report.notes.push('已将 '+report.extraInfo.hidden+' 段明确带 orangechat_extra_info 标记的自动背景快照移入消息附加元数据，不再作为少夜版正文显示或发送；原内容保留，转回 Kira 时可在消息未被改写的情况下恢复。历史搜索索引仍按原备份保留。');
 if(report.extraInfo.restored)report.notes.push('已从附加元数据恢复 '+report.extraInfo.restored+' 段 Kira 自动背景快照。');
 if(report.extraInfo.skipped)report.notes.push('有 '+report.extraInfo.skipped+' 项背景数据因结构变化或缺少普通消息段而未自动处理，已原样保留。');
 const output={};for(const [name,data] of Object.entries(files))if(!['rikka_hub.db','rikka_hub-wal','rikka_hub-shm'].includes(name)&&!name.startsWith('watermelon-bridge/'))output[name]=data;
 output['rikka_hub.db']=exported;
 output['watermelon-bridge/report.json']=enc.encode(JSON.stringify(report,null,2));
 progress('打包转换后的备份');const result=zip.zipSync(output,{level:6});
 return {bytes:result,report};
 }finally{dst.close()}
}
root.WatermelonBridge={inspect,convert,mergeWal,unpack,rows,scalar};
if(typeof module!=='undefined')module.exports=root.WatermelonBridge;
})(typeof self!=='undefined'?self:globalThis);

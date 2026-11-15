importScripts('./vendor/sql-wasm.js','./vendor/fflate.js','./extra-info.js','./bridge-core.js');
let state=null,original=null,originalName='',report=null;
const ready=Promise.all([initSqlJs({locateFile:f=>'./vendor/'+f}),fetch('./profiles.json').then(r=>{if(!r.ok)throw new Error('适配文件加载失败');return r.json()})]);
self.onmessage=async({data})=>{try{
 const [SQL,profiles]=await ready;
 if(data.action==='inspect'){
  state?.db.close();state=null;report=null;original=new Uint8Array(data.buffer);originalName=data.name;
  postMessage({type:'progress',text:'正在解压并核对数据库…'});
  state=WatermelonBridge.inspect(original,SQL,fflate,profiles);
  postMessage({type:'inspected',flavor:state.flavor,counts:state.counts,walFrames:state.walFrames,walTrailing:state.walTrailing});
 }else if(data.action==='convert'){
  if(!state)throw new Error('请先选择备份文件。');
  const result=WatermelonBridge.convert(state,data.target,SQL,fflate,profiles,text=>postMessage({type:'progress',text}));report=result.report;
  postMessage({type:'converted',buffer:result.bytes.buffer,report},[result.bytes.buffer]);
 }else if(data.action==='preserve'){
  if(!original||!report)throw new Error('请先完成转换。');
  const readme='这是转换前的完整原始备份，包含原版独有的字段、压缩摘要和设置。\n它不会自动合并到转换后的备份中。\n如需恢复原始状态，请解压后将 original-backup.zip 导入原来的 App。\n恢复的是转换前快照，不含转换后新增的聊天。\n原文件名：'+originalName;
  const packed=fflate.zipSync({'original-backup.zip':[original,{level:0}],'说明.txt':new TextEncoder().encode(readme),'转换报告.json':new TextEncoder().encode(JSON.stringify(report,null,2))},{level:6});
  postMessage({type:'preserved',buffer:packed.buffer},[packed.buffer]);
 }
}catch(e){postMessage({type:'error',message:e.message||String(e)})}};

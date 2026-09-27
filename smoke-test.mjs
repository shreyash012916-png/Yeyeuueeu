import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = process.cwd();
const tmp = path.join(root, 'tmp-smoke');
await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(tmp, { recursive: true });

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code ? reject(new Error(`${cmd} ${args.join(' ')}\n${err}`)) : resolve(out));
  });
}
async function probe(file) { return JSON.parse(await run('ffprobe', ['-v','error','-show_format','-show_streams','-of','json',file])); }
async function frameHash(file) { return (await run('ffmpeg', ['-hide_banner','-loglevel','error','-i',file,'-vf','scale=96:96','-frames:v','1','-f','md5','-'])).trim(); }

const videoFiles=[];
for (const [i, color, freq] of [['01','red','440'],['02','green','660'],['03','blue','880'],['04','yellow','990'],['05','magenta','550']]) {
  const file=path.join(tmp,`clip-${i}.mp4`); videoFiles.push(file);
  await run('ffmpeg', ['-y','-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${color}:size=640x360:rate=30:duration=2`,'-f','lavfi','-i',`sine=frequency=${freq}:sample_rate=48000:duration=2`,'-vf',`drawbox=x=40+80*sin(2*PI*t):y=30+25*sin(t):w=220:h=130:color=white@0.35:t=fill`,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2','-shortest',file]);
}
const music=path.join(tmp,'music.wav');
const voice=path.join(tmp,'voice.wav');
await run('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=10','-c:a','pcm_s16le',music]);
await run('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=7','-c:a','pcm_s16le',voice]);

const port='18080';
const proc=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:port,CUTFLOW_STORAGE_DIR:path.join(tmp,'store')}});
await sleep(700);
let sseReader;const events=[];
try{
  let r=await fetch(`http://127.0.0.1:${port}/`);if(!r.ok||!(await r.text()).includes('CUTFLOW'))throw new Error('frontend route failed');
  r=await fetch(`http://127.0.0.1:${port}/health`);if(!r.ok)throw new Error(`health ${r.status}`);const h=await r.json();if(h.status!=='ok'||!h.ffmpeg)throw new Error('health invalid');
  r=await fetch(`http://127.0.0.1:${port}/api/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({theme:'cinematic',aspectRatio:'9:16',targetDuration:10,instruction:'Create a 10 second cinematic montage. Use the strongest moments from the clips, build gently, then hit the music peak. Keep it premium, professional and do not use glitch.'})});
  let p=await r.json();if(!r.ok)throw new Error(p.error||'project creation failed');const id=p.id;
  const sse=await fetch(`http://127.0.0.1:${port}/api/projects/${id}/events`);if(!sse.ok)throw new Error('SSE route failed');sseReader=sse.body.getReader();
  const sseTask=(async()=>{const dec=new TextDecoder();let carry='';for(;;){const {done,value}=await sseReader.read();if(done)break;carry+=dec.decode(value,{stream:true});const parts=carry.split('\n\n');carry=parts.pop()||'';for(const part of parts){const line=part.split('\n').find(x=>x.startsWith('data: '));if(line){try{events.push(JSON.parse(line.slice(6)))}catch{}}}if(events.some(e=>e.status==='complete'||e.status==='error'))break;}})();
  for(let i=0;i<videoFiles.length;i++){
    const file=videoFiles[i],buf=await fs.readFile(file);r=await fetch(`http://127.0.0.1:${port}/api/projects/${id}/source-video/${encodeURIComponent(`asset-${i+1}`)}`,{method:'PUT',headers:{'content-type':'video/mp4','content-length':String(buf.length),'x-file-name':path.basename(file)},body:buf});if(!r.ok)throw new Error(await r.text());
  }
  for(const [endpoint,file,mime] of [['/source-music',music,'audio/wav'],['/source-voice',voice,'audio/wav']]){const buf=await fs.readFile(file);r=await fetch(`http://127.0.0.1:${port}/api/projects/${id}${endpoint}`,{method:'PUT',headers:{'content-type':mime,'content-length':String(buf.length),'x-file-name':path.basename(file)},body:buf});if(!r.ok)throw new Error(await r.text());}
  r=await fetch(`http://127.0.0.1:${port}/api/projects/${id}/create`,{method:'POST'});if(!r.ok)throw new Error(await r.text());
  for(let i=0;i<180;i++){await sleep(350);r=await fetch(`http://127.0.0.1:${port}/api/projects/${id}`);p=await r.json();if(p.status==='complete'||p.status==='error')break;}
  await sseTask;
  if(p.status!=='complete')throw new Error(p.error||'job did not complete');
  if(!p.output?.valid)throw new Error('output not marked valid');
  if(p.videos?.length!==5)throw new Error(`expected 5 uploaded assets, got ${p.videos?.length}`);
  const selectedIds=[...new Set((p.timeline?.clips||[]).map(c=>c.sourceAssetId))];
  if(selectedIds.length<4)throw new Error(`multi-clip editorial selection is weak: ${selectedIds.length} source assets used`);
  if(!p.timeline||p.timeline.clips.length<4)throw new Error('timeline did not use multiple clips');
  if(p.timeline.project.duration<9.3||p.timeline.project.duration>10.7)throw new Error(`timeline target mismatch: ${p.timeline.project.duration}`);
  const outPath=path.join(tmp,'download.mp4');const outResp=await fetch(`http://127.0.0.1:${port}/api/projects/${id}/output`);if(!outResp.ok)throw new Error(`output ${outResp.status}`);await fs.writeFile(outPath,Buffer.from(await outResp.arrayBuffer()));
  const outProbe=await probe(outPath);const ov=outProbe.streams.find(s=>s.codec_type==='video');const oa=outProbe.streams.find(s=>s.codec_type==='audio');
  if(!ov||!oa)throw new Error('final MP4 missing video/audio');if(ov.width!==1080||ov.height!==1920)throw new Error(`output resolution ${ov.width}x${ov.height}`);
  const outDuration=Number(outProbe.format?.duration||0);if(outDuration<9.1||outDuration>10.9)throw new Error(`output duration ${outDuration}`);
  const sourceHash=await frameHash(videoFiles[0]);const outputHash=await frameHash(outPath);if(sourceHash===outputHash)throw new Error('output first-frame hash matches source; edit may be a copy');
  const renderEvents=events.filter(e=>e.render?.phase==='rendering'&&e.render?.currentClip>0);if(renderEvents.length<2)throw new Error(`live clip render events missing: ${renderEvents.length}`);
  if(!events.some(e=>e.progress?.percent===100&&e.status==='complete'))throw new Error('live completion event missing');
  if(!events.some(e=>e.ai?.status==='offline'&&e.ai?.model==='gemini-3.8-flash'))throw new Error('Gemini offline state was not surfaced');
  if((p.timeline.music?.musicVolume||0)<=0||p.voice===null)throw new Error('audio tracks not represented');

  r=await fetch(`http://127.0.0.1:${port}/api/projects/${id}/commands`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command:'Make it darker and remove flashy effects. Keep the voice clear.'})});
  const v2=await r.json();if(!r.ok||v2.versions?.length<2)throw new Error('versioned command failed');if(!v2.output?.valid)throw new Error('v2 output invalid');

  console.log('DEEP_MULTI_CLIP_SMOKE_OK',JSON.stringify({uploadedAssets:p.videos.length,selectedSourceAssets:selectedIds.length,selectedTimelineClips:p.timeline.clips.length,targetDuration:p.timeline.project.duration,outputDuration:outDuration,outputBytes:Number(outProbe.format?.size||0),pixelHashChanged:sourceHash!==outputHash,sseEvents:events.length,renderEvents:renderEvents.length,geminiStatus:p.ai?.status,versionCount:v2.versions.length,outputResolution:`${ov.width}x${ov.height}`,voiceTrack:true}));
} finally {try{await sseReader?.cancel()}catch{}proc.kill('SIGTERM');await sleep(200);await fs.rm(tmp,{recursive:true,force:true});}

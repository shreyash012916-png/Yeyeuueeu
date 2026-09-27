import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = 18181;
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/upload/v1beta/files') && req.method === 'POST' && req.headers['x-goog-upload-command'] === 'start') {
    res.writeHead(200, {'x-goog-upload-url': `http://127.0.0.1:${port}/upload-finalize`});
    return res.end(JSON.stringify({}));
  }
  if (req.url === '/upload-finalize' && req.method === 'POST') {
    const mime = req.headers['content-type'] || 'application/octet-stream';
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({file:{mime_type:mime,uri:'mock://uploaded'}}));
  }
  if (req.url.startsWith('/v1beta/models/gemini-3.8-flash') && req.method === 'GET') {
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({name:'models/gemini-3.8-flash'}));
  }
  if (req.url.startsWith('/v1beta/models/gemini-3.8-flash:generateContent') && req.method === 'POST') {
    let body=''; for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    const text = parsed.contents?.[0]?.parts?.find(p => p.text)?.text || '';
    const plan = text.includes('EXISTING CUTFLOW timeline')
      ? {summary:'mock command',operations:[{op:'removeEffects'}]}
      : {summary:'mock editorial plan',editorialNotes:['Use strongest shots'],clipOrder:['asset-1:shot-1'],targetDuration:5,captions:[],text:[],clipOverrides:[],audio:{useOriginalAudio:true,musicVolume:.38,voiceVolume:.92}};
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(plan)}]}}]}));
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(port,'127.0.0.1',resolve));
process.env.GEMINI_API_KEY=['mock','key'].join('-');
process.env.GEMINI_API_BASE_URL=`http://127.0.0.1:${port}`;
const {editorialPlan, commandPlan, healthProbe} = await import('./gemini.js?mock=1');
const dir = await fs.mkdtemp(path.join(os.tmpdir(),'cutflow-gemini-'));
const video = path.join(dir,'video.mp4');
const audio = path.join(dir,'audio.mp3');
await fs.writeFile(video, Buffer.alloc(32,1));
await fs.writeFile(audio, Buffer.alloc(32,2));
try {
  const health = await healthProbe();
  if (!health.available || health.model !== 'gemini-3.8-flash') throw new Error('Gemini health probe failed');
  const plan = await editorialPlan({
    videoAssets:[{id:'asset-1',path:video,name:'video.mp4',mimeType:'video/mp4'}],
    musicPath:audio,
    voicePath:null,
    project:{theme:'cinematic',aspectRatio:'9:16',targetDuration:5},
    videoAnalysis:{duration:5,assetCount:1,assets:[{id:'asset-1',name:'video.mp4',duration:5,width:640,height:360,fps:30,hasAudio:false,scenes:[{id:'shot-1',start:0,end:5,duration:5,motionScore:.5,qualityScore:.7,compositionScore:.7,subjectScore:.6,energyScore:.5,sharpnessScore:.7,brightnessScore:.5,subjectX:.5}]}]},
    audioAnalysis:{duration:5,mimeType:'audio/mpeg',bpm:120,beatPositions:[],onsetPositions:[],onsetCount:0,sections:[]},
    voiceAnalysis:null,
    instruction:'make it cinematic'
  });
  if (!plan.available || plan.model !== 'gemini-3.8-flash' || !plan.plan) throw new Error('Gemini editorial plan failed');
  const command = await commandPlan({timeline:{project:{duration:5},clips:[]},command:'remove flashy effects',project:{theme:'hype',aspectRatio:'9:16'}});
  if (!command.available || !command.modification?.operations?.length) throw new Error('Gemini command plan failed');
  console.log('GEMINI_INTEGRATION_SMOKE_OK', JSON.stringify({model:plan.model,planSummary:plan.plan.summary,commandOps:command.modification.operations.length}));
} finally {
  server.close();
  await fs.rm(dir,{recursive:true,force:true});
}

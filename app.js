// EarFour — WorkinWithAI. You can play the chords, you just can't get them into the track. Strum (or play) 4 bars of chords
// on ANY instrument into your mic, or on a MIDI keyboard, over YOUR BPM. EarFour hears one chord per bar, writes them into the
// 4-chord entry, and seats a real sampled band (FluidR3 piano, finger bass, strings + CC0 Virtuosity kit) on exactly those chords.
// Every loop pass is a new take (your dry audio + the chords it heard). Exports a DAW-grid WAV, band + chord MIDI, take stems.
// Live samples only, pinned to commit SHAs. No synth stand-ins.
const APP = "earfour";
const FLUID_SHA = "044fab8e1456bfafc5776e86dfd6bb8697149aef"; // gleitz/midi-js-soundfonts
const KIT_SHA = "9f04cf9a734527edfbb0a4eee1f674e45bbf71bc";   // sfzinstruments/virtuosity_drums
const FLUID = `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@${FLUID_SHA}/FluidR3_GM`;
const KIT = `https://cdn.jsdelivr.net/gh/sfzinstruments/virtuosity_drums@${KIT_SHA}/Samples`;
const SR = 48000, LOOKAHEAD_MS = 25, SCHEDULE_AHEAD = 0.12, STEPS = 16, MAX_SHIFT = 4, LOOP_BARS = 4, L = LOOP_BARS*STEPS;
const NAMES = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];
const FLAT = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const noteName = n => FLAT[n%12] + (Math.floor(n/12)-1);
const CHAIRS = [
  { id:"take",  name:"Your audio takes (dry, as recorded)", ch:-1 },
  { id:"piano", name:"Piano on your chords (FluidR3 Acoustic Grand)", ch:1 },
  { id:"bass",  name:"Finger bass (FluidR3 Electric Bass finger)", ch:0 },
  { id:"pad",   name:"String pad (FluidR3 String Ensemble 1)", ch:2 },
  { id:"kit",   name:"Backing kit (Virtuosity Drums, CC0)", ch:9 },
];
const SETS = { piano:"Acoustic grand piano (FluidR3)", bass:"Finger bass (FluidR3)", pad:"String ensemble (FluidR3)" };
const RANGE = { piano:[36,96], bass:[28,55], pad:[52,76] };
const PROGRAM = { piano:"acoustic_grand_piano", bass:"electric_bass_finger", pad:"string_ensemble_1" };
const KITMAP = { 36:"kickmic/kick/kickmic_kick_snoff_vl3_rr1.flac", 38:"mid/snare/mid_snare_center_vl24.flac", 42:"mid/hh/mid_hh_closed_vl3_rr1.flac" };
const KITNAME = { 36:"kick", 38:"snare", 42:"closed hi-hat" };
const recipes = [
  { id:"straight", name:"Straight", blurb:"Piano on 1 and 3, bass on the root, steady backbeat. The default." },
  { id:"push", name:"Push", blurb:"Piano and bass anticipate each new chord on the last 16th of the bar." },
  { id:"half", name:"Half-time", blurb:"Snare on 3 only, piano holds the whole bar. Heavier, slower feel." },
  { id:"drive", name:"Drive", blurb:"Piano in 8ths, bass in 8ths. Pushes a strummed idea forward." },
];
const grooves = [
  { id:"porch", name:"Porch Light", bpm:92, chords:"Am F C G" },
  { id:"slow",  name:"Slow Ballad", bpm:68, chords:"C Am F G" },
  { id:"drive", name:"Night Drive", bpm:112, chords:"Em C G D" },
];
const QUAL = {"":[0,4,7], m:[0,3,7], min:[0,3,7], "7":[0,4,7,10], m7:[0,3,7,10], maj7:[0,4,7,11], dim:[0,3,6], sus2:[0,2,7], sus4:[0,5,7]};
const ROOT = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const pc = x => ((x%12)+12)%12;
const inRange = (n,lo,hi) => { while(n<lo) n+=12; while(n>hi) n-=12; return n; };

// ---------- state (one mutable object, persisted) ----------
const DEFAULT = { bpm:92, keyRoot:9, chords:"Am F C G", groove:"porch", recipe:"straight", bars:8, audioOut:"", audioIn:"",
  listen:"auto", autoUse:true, recClick:true, layer:false, trimDb:0, gate:false, gateDb:-50, monitor:true, latencyFixMs:0, vocab:"triads",
  mutes:{take:false,piano:false,bass:false,pad:false,kit:false}, gains:{take:0.9,piano:0.45,bass:0.8,pad:0.22,kit:0.65},
  youGain:1.0, bandGain:0.8, master:0.9, wavTakes:false,
  midiIn:"", midiOut:"", midiTransport:false, liveInst:"piano", liveOct:4, seenGuide:false };
const state = Object.assign({}, DEFAULT, JSON.parse(localStorage.getItem(APP+"-settings")||"{}"));
state.mutes = Object.assign({}, DEFAULT.mutes, state.mutes); state.gains = Object.assign({}, DEFAULT.gains, state.gains);
if(!recipes.some(r=>r.id===state.recipe)) state.recipe="straight";
if(!RANGE[state.liveInst]) state.liveInst="piano";
const save = () => localStorage.setItem(APP+"-settings", JSON.stringify(state));
function parseChord(s){ const m=/^([A-G])(#|b)?(maj7|min|m7|m|7|dim|sus2|sus4)?$/.exec(s.trim()); if(!m) return null;
  return { root:pc(ROOT[m[1]]+(m[2]==="#"?1:m[2]==="b"?-1:0)), ivs:QUAL[m[3]||""], q:m[3]||"", minor:/^m(?!aj)|^min|^dim/.test(m[3]||""), name:s.trim() }; }
function parseProg(str){ const t=str.trim().split(/[\s,|]+/).filter(Boolean); if(t.length!==4) return null; const c=t.map(parseChord); return c.includes(null)?null:c; }
let prog = parseProg(state.chords) || parseProg(DEFAULT.chords);
const transpose = () => pc(state.keyRoot - prog[0].root);
const keyLabel = () => NAMES[state.keyRoot].replace("#","s") + (prog[0].minor?"m":"");
const chordName = i => NAMES[pc(prog[i].root+transpose())] + prog[i].q;
function chordAtBar(bar, st, pr){ const c=pr[((bar%4)+4)%4], r=pc(c.root+pc(st.keyRoot-pr[0].root)); return {root:r, ivs:c.ivs, tones:c.ivs.map(iv=>pc(r+iv))}; }

// ---------- the ear: chroma -> chord (deterministic, no randomness) ----------
const VOCABS = { triads:["","m"], sevenths:["","m","7","m7","maj7"], all:["","m","7","m7","maj7","sus2","sus4","dim"] };
const PENALTY = { "":0, m:0, "7":0.035, m7:0.035, maj7:0.04, sus2:0.05, sus4:0.05, dim:0.06 };
function detectChord(chroma, bassPc, vocab){
  const tot=chroma.reduce((a,b)=>a+b,0); if(!(tot>0)) return null;
  const nrm=Math.sqrt(chroma.reduce((a,b)=>a+b*b,0)); const res=[];
  for(let r=0;r<12;r++) for(const q of VOCABS[vocab||"sevenths"]){ const t=new Array(12).fill(0); QUAL[q].forEach((iv,i)=>t[pc(r+iv)]=i===0?1.15:1);
    const tn=Math.sqrt(t.reduce((a,b)=>a+b*b,0)); let dot=0; for(let k=0;k<12;k++) dot+=chroma[k]*t[k];
    res.push({root:r,q,score:dot/(nrm*tn) - PENALTY[q] + (bassPc===r?0.08:0)}); }
  res.sort((a,b)=>b.score-a.score); const b=res[0], second=res.find(x=>x.root!==b.root)||res[1];
  return { name:FLAT[b.root]+b.q, root:b.root, q:b.q, score:+b.score.toFixed(3), conf:+Math.max(0,Math.min(1,(b.score-second.score)*6)).toFixed(2), bass:bassPc }; }
function fft(re, im){ const n=re.length; for(let i=1,j=0;i<n;i++){ let bit=n>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit; if(i<j){ [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; } }
  for(let len=2;len<=n;len<<=1){ const a=-2*Math.PI/len, wr=Math.cos(a), wi=Math.sin(a);
    for(let i=0;i<n;i+=len){ let cr=1,ci=0; for(let k=0;k<len/2;k++){ const h=i+k+len/2, ur=re[i+k],ui=im[i+k], xr=re[h]*cr-im[h]*ci, xi=re[h]*ci+im[h]*cr;
      re[i+k]=ur+xr; im[i+k]=ui+xi; re[h]=ur-xr; im[h]=ui-xi; const t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t; } } } }
function chromaFromPcm(x, sr){ // -> {chroma[12], bass, rms}
  const N = sr>60000 ? 16384 : 8192, hop=N/2, chroma=new Array(12).fill(0), bassE=new Array(12).fill(0); let e2=0;
  for(let i=0;i<x.length;i++) e2+=x[i]*x[i]; const rms=Math.sqrt(e2/Math.max(1,x.length));
  const win=new Float32Array(N); for(let i=0;i<N;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(N-1));
  const re=new Float64Array(N), im=new Float64Array(N), lo=Math.ceil(50*N/sr), hi=Math.floor(2100*N/sr), bhi=Math.floor(260*N/sr);
  for(let s=0; s<x.length; s+=hop){
    for(let i=0;i<N;i++){ re[i]=(x[s+i]||0)*win[i]; im[i]=0; } fft(re,im);
    for(let k=lo;k<=hi;k++){ const f=k*sr/N, m=Math.sqrt(re[k]*re[k]+im[k]*im[k]); if(m<=0) continue; const midi=69+12*Math.log2(f/440), p=pc(Math.round(midi));
      if(Math.abs(midi-Math.round(midi))>0.4) continue; chroma[p]+=Math.sqrt(m); if(k<=bhi) bassE[p]+=m; }
    if(s+N>=x.length) break; }
  const bass = bassE.some(v=>v>0) ? bassE.indexOf(Math.max(...bassE)) : null; return {chroma, bass, rms}; }
function chromaFromNotes(notes, t0, t1){ const chroma=new Array(12).fill(0); let low=null;
  for(const n of notes){ const a=Math.max(t0,n.on), b=Math.min(t1, n.off==null?t1:n.off); if(b<=a) continue; chroma[pc(n.note)]+=(b-a)*(0.3+n.vel); if(low===null||n.note<low) low=n.note; }
  return {chroma, bass: low===null?null:pc(low), rms: chroma.some(v=>v>0)?1:0}; }
const MIN_RMS = 0.004;
function hearBars(pcmBars, noteBars, vocab){ // per bar: MIDI/keys notes win when present (they are exact), else the mic
  return [0,1,2,3].map(b=>{ const n=noteBars&&noteBars[b], a=pcmBars&&pcmBars[b];
    if(n && n.rms>0){ const d=detectChord(n.chroma,n.bass,vocab); return d&&Object.assign(d,{from:"keys/MIDI"}); }
    if(a && a.rms>=MIN_RMS){ const d=detectChord(a.chroma,a.bass,vocab); return d&&Object.assign(d,{from:"mic"}); }
    return null; }); }
function fillGaps(heard, fallback){ const out=[]; for(let b=0;b<4;b++){ const h=heard[b]||heard.slice(0,b).reverse().find(Boolean)||heard.find(Boolean); out.push(h?h.name:fallback[b]); } return out; }

// ---------- takes: every loop pass while recording is a NEW take (chords + dry audio); chords in localStorage, audio in IndexedDB ----------
const TAKE_CAP=16, TAKE_KEY=APP+"-takes";
const takes=(()=>{ try{ const a=JSON.parse(localStorage.getItem(TAKE_KEY)||"[]"); return Array.isArray(a)?a.filter(t=>t&&Array.isArray(t.chords)):[]; }catch(e){ return []; } })();
const audioStore=new Map(); // take id -> {data:Float32Array, sr}
let takesVer=1;
function saveTakes(){ takesVer++; try{ localStorage.setItem(TAKE_KEY,JSON.stringify(takes)); }catch(e){ setStatus("Could not save takes in this browser (storage full?). Export them now."); } }
let dbP=null; const db=()=> dbP||(dbP=new Promise((res,rej)=>{ if(!window.indexedDB) return rej(new Error("no IndexedDB")); const r=indexedDB.open(APP,1); r.onupgradeneeded=()=>r.result.createObjectStore("audio"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }));
const idb=(mode,fn)=>db().then(d=>new Promise((res,rej)=>{ const tx=d.transaction("audio",mode), st=tx.objectStore("audio"), q=fn(st); tx.oncomplete=()=>res(q&&q.result); tx.onerror=()=>rej(tx.error); }));
const putAudio=(id,a)=>idb("readwrite",s=>s.put({data:a.data.buffer.slice(0),sr:a.sr},id)).catch(()=>{});
const delAudio=id=>idb("readwrite",s=>s.delete(id)).catch(()=>{});
const loadAudio=()=>Promise.all(takes.filter(t=>t.hasAudio).map(t=>idb("readonly",s=>s.get(t.id)).then(v=>{ if(v) audioStore.set(t.id,{data:new Float32Array(v.data),sr:v.sr}); }).catch(()=>{}))).then(()=>{ renderTakes(); });
const audible = t => t.mode==="loop" && !t.muted;
// a take's audio only plays (and goes in the band WAV) while the band is at the BPM and key it was played in
const audioFits = t => audioStore.has(t.id) && t.bpm===state.bpm && t.key===state.keyRoot;

// ---------- band: piano voice-led across the 4 bars ----------
let vlCache={key:null};
function closeVoicings(c){ const out=[]; for(let lo=52;lo<=62;lo++){ if(!c.tones.includes(pc(lo))) continue; const v=[lo]; for(const t of c.tones) if(t!==pc(lo)) v.push(lo+pc(t-lo)); out.push(v.sort((a,b)=>a-b)); } return out; }
function ledVoicings(st, pr){ const key=JSON.stringify([st.keyRoot,pr.map(c=>c.name)]); if(vlCache.key===key) return vlCache.v;
  const v=[]; let prev=null;
  for(let b=0;b<4;b++){ const cand=closeVoicings(chordAtBar(b,st,pr)); let best=cand[0], bs=Infinity;
    for(const x of cand){ const s = prev ? x.reduce((a,n,i)=>a+Math.abs(n-(prev[Math.min(i,prev.length-1)])),0) : Math.abs(x[0]-55); if(s<bs){bs=s;best=x;} }
    v.push(best); prev=best; }
  vlCache={key,v}; return v; }
// ---------- arrangement: one function feeds live, WAV and MIDI (deterministic) ----------
function stepEvents(step, st, pr){
  const out=[], bar=Math.floor(step/STEPS), s=step%STEPS, R=st.recipe, push=R==="push" && s===15, cb=push?bar+1:bar, c=chordAtBar(cb,st,pr), cur=chordAtBar(bar,st,pr);
  const b=inRange(28+pc(c.root-28),28,39), pv=cur.ivs.slice(0,4).map(iv=>inRange(57+pc(cur.root+iv-57),57,70)).sort((x,y)=>x-y), vo=ledVoicings(st,pr)[((cb%4)+4)%4];
  const loopStart = step%L===0;
  if(!st.mutes.bass){
    if(R==="drive"){ if(s%2===0) out.push({part:"bass",src:"bass",note:b,dur:2,vel:s%4?0.7:0.9}); }
    else if(R==="push"){ if(s===0&&loopStart) out.push({part:"bass",src:"bass",note:b,dur:6,vel:0.95}); if(s===8) out.push({part:"bass",src:"bass",note:b,dur:4,vel:0.8}); if(s===15) out.push({part:"bass",src:"bass",note:b,dur:9,vel:0.95}); }
    else { if(s===0) out.push({part:"bass",src:"bass",note:b,dur:R==="half"?14:6,vel:0.95}); if(s===8&&R!=="half") out.push({part:"bass",src:"bass",note:b,dur:4,vel:0.8}); if(s===14&&R!=="half") out.push({part:"bass",src:"bass",note:b+12,dur:2,vel:0.6}); } }
  if(!st.mutes.piano){
    const hit = R==="drive" ? s%2===0 : R==="half" ? s===0 : R==="push" ? (s===8||s===15||(s===0&&loopStart)) : (s===0||s===8);
    if(hit) for(const n of vo) out.push({part:"piano",src:"piano",note:n,dur:R==="half"?15:R==="drive"?2:s===15?9:7,vel:s===0||s===15?0.62:0.5}); }
  if(!st.mutes.pad && s===0) for(const n of pv) out.push({part:"pad",src:"pad",note:n,dur:16,vel:0.5});
  if(!st.mutes.kit){ if(s===0||(s===10&&R!=="half")) out.push({part:"kit",src:"kit",note:36,dur:1,vel:s?0.75:0.95});
    if(R==="half"){ if(s===8) out.push({part:"kit",src:"kit",note:38,dur:1,vel:0.85}); } else if(s===4||s===12) out.push({part:"kit",src:"kit",note:38,dur:1,vel:0.8});
    if(s%2===0) out.push({part:"kit",src:"kit",note:42,dur:1,vel:s%4?0.35:0.5}); }
  return out;
}

// ---------- samples: pinned CDN, raw ArrayBuffers kept for export ----------
const files = [];
for (const id of ["piano","bass","pad"]) for (let n=RANGE[id][0]; n<=RANGE[id][1]; n++) files.push({ id, note:n, url:`${FLUID}/${PROGRAM[id]}-mp3/${noteName(n)}.mp3`, label:SETS[id] });
for (const [n,p] of Object.entries(KITMAP)) files.push({ id:"kit", note:+n, url:`${KIT}/${p}`, label:`Kit ${KITNAME[n]} (Virtuosity Drums)` });
const raw = {}, missing = new Set(); let loaded = 0, loadDone = false;
const loadAll = (async () => {
  let i = 0; const worker = async () => { while (i < files.length) { const f = files[i++];
    try { const r = await fetch(f.url); if (!r.ok) throw new Error(r.status); raw[f.url] = await r.arrayBuffer(); }
    catch (e) { missing.add(f.label + " (" + f.url.split("/").pop() + ")"); }
    loaded++; showLoad(); } };
  await Promise.all(Array.from({length:8}, worker)); loadDone = true; showLoad();
})();
function showLoad(){
  const el = document.getElementById("status"); if(!el) return;
  if (missing.size) { el.className="status miss"; const inst=[...new Set([...missing].map(m=>m.replace(/ \(.*$/,"")))];
    el.textContent = `Missing instruments, playback and export disabled: ${inst.join(", ")} — ${missing.size} file(s) failed, e.g. ${[...missing].slice(0,3).join(", ")}`; }
  else if(!el.dataset.msg) el.textContent = loadDone ? `Band seated ${loaded}/${files.length} · live FluidR3 + CC0 kit` : `Seating the band ${loaded}/${files.length}`;
  const ok = loadDone && !missing.size; ["playA","playB","recBtn","recBtn2","exportWav","exportMid","exportStems","demoBtn"].forEach(id=>{ const b=document.getElementById(id); if(b) b.disabled=!ok; });
}
async function decodeAll(c){ // -> {id:{note:{buf,offset}}}; offset skips MP3 encoder padding so notes land on the grid
  const out={};
  await Promise.all(files.map(async f => { const buf = await c.decodeAudioData(raw[f.url].slice(0));
    const d0=buf.getChannelData(0); let pk=0; for(let i=0;i<d0.length;i++){ const a=Math.abs(d0[i]); if(a>pk) pk=a; }
    let on=0; while(on<d0.length && Math.abs(d0[on])<pk*0.01) on++; on=Math.max(0,on-2);
    (out[f.id]=out[f.id]||{})[f.note] = { buf, offset:on/buf.sampleRate }; }));
  return out;
}
function pick(id, note){ if(id==="kit") return note; const [lo,hi]=RANGE[id]; const n=Math.min(hi,Math.max(lo,note)); if(Math.abs(n-note)>MAX_SHIFT) throw new Error(id+" out of range "+note); return n; }

// ---------- sampler voice ----------
const REL = { kit:0.03, bass:0.06, piano:0.15, pad:0.25 };
const HOLD = id => id==="pad";
const ATK = { pad:0.12 };
function voice(c, bufs, dest, ev, t, sd, track){
  const id = ev.src, r = pick(id, ev.note), smp = bufs[id][r], buf = smp.buf, rate = Math.pow(2,(ev.note-r)/12);
  const end = t + ev.dur*sd, rel = REL[id], g = c.createGain(); g.connect(dest);
  const usable = (buf.duration - smp.offset)/rate - 0.05;
  let off = id==="kit" ? t + Math.min(usable, ev.note===42?0.22:0.7) : end;
  if (!HOLD(id)) off = Math.min(off, t + usable - rel);
  if (id==="kit") g.gain.setValueAtTime(ev.vel, t);
  else { g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(ev.vel, t+(ATK[id]||0.003)); }
  g.gain.setValueAtTime(ev.vel, off); g.gain.linearRampToValueAtTime(0, off+rel);
  const srcs=[]; const XF=0.25, LOOP_FROM=1.0; let segStart=t, segOff=smp.offset, first=true;
  for(;;){
    const s=c.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate; const sg=c.createGain(); s.connect(sg); sg.connect(g);
    const segEnd = segStart + (buf.duration-segOff)/rate - 0.05;
    if(!first){ sg.gain.setValueAtTime(0,segStart); sg.gain.linearRampToValueAtTime(1,segStart+XF); }
    s.start(segStart, segOff);
    if(HOLD(id) && segEnd < off+rel){ sg.gain.setValueAtTime(1,segEnd-XF); sg.gain.linearRampToValueAtTime(0,segEnd); s.stop(segEnd+0.01); srcs.push(s); segStart=segEnd-XF; segOff=LOOP_FROM; first=false; }
    else { s.stop(off+rel+0.01); srcs.push(s); break; }
  }
  if(track) for(const s of srcs){ active.add(s); s.onended=()=>active.delete(s); }
}
function takeVoice(c, a, dest, t, track){ // one pass of a dry audio take, 5 ms fades so the loop seam never clicks
  const b=c.createBuffer(1,a.data.length,a.sr); b.copyToChannel(a.data,0); const s=c.createBufferSource(); s.buffer=b; const g=c.createGain(); s.connect(g); g.connect(dest);
  const d=a.data.length/a.sr; g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(1,t+0.005); g.gain.setValueAtTime(1,t+d-0.005); g.gain.linearRampToValueAtTime(0,t+d);
  s.start(t); s.stop(t+d+0.01); if(track){ active.add(s); s.onended=()=>active.delete(s); } }
function makeComp(c){ const k=c.createDynamicsCompressor(); k.threshold.value=-8; k.knee.value=6; k.ratio.value=12; k.attack.value=0.003; k.release.value=0.15; return k; }
// chairs -> A/B makeup -> Band fader -> Master -> limiter -> out. Your playing (keys, MIDI, mic monitor) -> its own fader -> Master.
function buildBus(c, st){ const comp=makeComp(c), master=c.createGain(), band=c.createGain(), ab=c.createGain(), you=c.createGain();
  master.gain.value=st.master; band.gain.value=st.bandGain; you.gain.value=st.youGain;
  ab.connect(band); band.connect(master); you.connect(master); master.connect(comp); comp.connect(c.destination); const chairs={};
  for(const ch of CHAIRS){ const g=c.createGain(); g.gain.value=st.gains[ch.id]; g.connect(ab); chairs[ch.id]=g; } return {comp,master,band,ab,you,chairs}; }

// ---------- live engine: lookahead scheduler on the audio clock ----------
let ctx=null, bus=null, liveBufs=null, timerId=null, nextStepTime=0, step=0, playing=false, mode=null, passNo=0;
const active=new Set(), stepLog=[]; window.__schedLog=[];
async function ensureCtx(){
  // live context at the device's default rate (mic lesson); exports render offline at 48 kHz
  if(!ctx){ ctx=new (window.AudioContext||window.webkitAudioContext)(); bus=buildBus(ctx,state); applySink(); }
  await ctx.resume(); if(!liveBufs){ await loadAll; if(!missing.size) liveBufs=await decodeAll(ctx); }
}
async function start(m){
  if(!ctx||ctx.state!=="running"||!liveBufs||missing.size) return;
  stop(); const mk = m==="thin" ? await makeupGain() : 1; bus.ab.gain.setValueAtTime(mk, ctx.currentTime); mode=m;
  nextStepTime=ctx.currentTime+0.1; step=0; stepLog.length=0; playing=true; passNo=0;
  timerId=setInterval(scheduler, LOOKAHEAD_MS); scheduler(); requestAnimationFrame(draw); paintDock();
}
function scheduler(){ while(nextStepTime < ctx.currentTime+SCHEDULE_AHEAD){ scheduleStep(step, nextStepTime); nextStepTime += 60/state.bpm/4; step=(step+1)%L; } if(mode==="rec") recTick(); }
function thinState(){ return merged({mutes:{bass:true,pad:true,kit:true}}); } // A = your takes + piano on your chords only
function scheduleStep(st, time){
  const sd=60/state.bpm/4, S = mode==="thin" ? thinState() : state, evs = stepEvents(st, S, prog);
  if(mode==="rec" && state.recClick && st%4===0) evs.push({part:"kit",src:"kit",note:42,dur:1,vel:st%16===0?0.5:0.3,click:true});
  for(const ev of evs){ voice(ctx, liveBufs, bus.chairs[ev.part], ev, time, sd, true); if(!ev.click) midiSend(ev, time, sd); }
  if(st===0){ passNo++; if(mode==="rec") recPasses.push({pass:passNo, time, sd, done:false});
    else if(!S.mutes.take) for(const t of takes) if(audible(t)&&audioFits(t)) takeVoice(ctx, audioStore.get(t.id), bus.chairs.take, time, true); }
  stepLog.push({bar:Math.floor(st/STEPS), s:st%STEPS, st, pass:passNo, time}); if(stepLog.length>256) stepLog.shift();
  window.__schedLog.push({step:st, time, bpm:state.bpm, recipe:state.recipe, keyRoot:state.keyRoot, chords:state.chords, mode, mutes:Object.assign({},state.mutes), notes:evs.map(e=>e.part+":"+e.note)});
  if(window.__schedLog.length>3000) window.__schedLog.shift();
}
function stop(){
  const wasRec = mode==="rec", stopAt = ctx ? ctx.currentTime : 0;
  clearInterval(timerId); timerId=null; playing=false; mode=null;
  for(const s of active){ try{ s.stop(); }catch(e){} } active.clear();
  if(midiOut) for(const c of CHAIRS) if(c.ch>=0) midiOut.send([0xB0|c.ch,123,0]);
  document.querySelectorAll(".bar4").forEach(b=>b.classList.remove("active"));
  if(wasRec) finishRec(stopAt);
  paintDock();
}
function draw(){ // playhead from ctx.currentTime
  if(!playing) return; const now=ctx.currentTime; let cur=null;
  for(const e of stepLog){ if(e.time<=now) cur=e; else break; }
  if(cur){ const frac=Math.min(1,(now-cur.time)/(60/state.bpm/4)), fr=(cur.s+frac)/STEPS;
    document.querySelectorAll(".bar4").forEach((el,i)=>{ el.classList.toggle("active",i===cur.bar); if(i===cur.bar) el.querySelector(".ph").style.left=(fr*100)+"%"; }); }
  updateHint(); paintMeter(); requestAnimationFrame(draw);
}
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="hidden"){ if(playing){ stop(); setStatus("Stopped (tab hidden). Press play to start again."); } liveAllOff(); } });

// ---------- export ----------
let compLatency=null;
async function measureCompLatency(){
  if(compLatency!==null) return compLatency;
  const oc=new OfflineAudioContext(1,4096,SR), b=oc.createBuffer(1,600,SR), x=b.getChannelData(0); for(let i=0;i<600;i++) x[i]=0.3*Math.sin(2*Math.PI*60*i/SR);
  const s=oc.createBufferSource(); s.buffer=b; const k=makeComp(oc); s.connect(k); k.connect(oc.destination); s.start(0);
  const d=(await oc.startRendering()).getChannelData(0); let best=0,bv=-Infinity;
  for(let Lg=0;Lg<1024;Lg++){ let c=0; for(let i=0;i<600;i++) c+=x[i]*d[i+Lg]; if(c>bv){bv=c;best=Lg;} } return compLatency=best;
}
function merged(o){ const st=Object.assign({},state,o||{}); st.mutes=Object.assign({},state.mutes,(o||{}).mutes); st.gains=Object.assign({},state.gains,(o||{}).gains); return st; }
async function renderLoop(o, noNorm){
  await loadAll; if(missing.size) throw new Error("Missing samples");
  const st=merged(o), N=Math.round(st.bars*4*60/st.bpm*SR), TAIL=Math.round(3*SR), D=await measureCompLatency();
  const pr=(st.chords!==state.chords && parseProg(st.chords)) || prog;
  const oc=new OfflineAudioContext(2, D+N+TAIL, SR), bufs=await decodeAll(oc), b=buildBus(oc, Object.assign({},st,{master:1,bandGain:1})), sd=60/st.bpm/4;
  if(!st.onlyTake) for(let s=0;s<st.bars*STEPS;s++){ for(const ev of stepEvents(s, st, pr)) voice(oc, bufs, b.chairs[ev.part], ev, s*sd, sd, false); }
  const tlist = st.onlyTake ? [st.onlyTake] : (st.withTakes && !st.mutes.take ? takes.filter(t=>audible(t)&&audioStore.has(t.id)&&t.bpm===st.bpm&&t.key===st.keyRoot) : []);
  for(const t of tlist){ const a=audioStore.get(t.id); if(!a) continue; for(let p=0;p<(st.onlyTake?1:st.bars/LOOP_BARS);p++) takeVoice(oc, a, b.chairs.take, p*L*sd, false); }
  const buf=await oc.startRendering();
  const ch=[0,1].map(i=>{ const d=buf.getChannelData(i), x=new Float32Array(N); x.set(d.subarray(D,D+N)); if(!st.onlyTake) for(let j=0;j<TAIL;j++) x[j%N]+=d[D+N+j]; return x; });
  if(noNorm) return {ch,N,st,pr};
  let pk=0; for(const d of ch) for(let i=0;i<N;i++){ const a=Math.abs(d[i]); if(a>pk) pk=a; }
  let k=pk>0?Math.pow(10,-1.1/20)/pk:1; if(st.stem) k=Math.min(1,k); for(const d of ch) for(let i=0;i<N;i++) d[i]*=k;
  return {ch,N,st,pr};
}
// A (your takes + piano on your chords) and B (full band) at matched loudness: makeup measured offline
let mkCache={key:null,v:1};
async function makeupGain(){ const key=JSON.stringify([takesVer,state.recipe,state.gains,state.mutes,state.chords,state.keyRoot,state.bpm]);
  if(mkCache.key===key) return mkCache.v;
  try{ const rms=r=>{ let s=0; for(const d of r.ch) for(let i=0;i<r.N;i++) s+=d[i]*d[i]; return Math.sqrt(s/(2*r.N)); };
    const a=await renderLoop({bars:4,withTakes:true,mutes:{bass:true,pad:true,kit:true}},true), b=await renderLoop({bars:4,withTakes:true},true);
    const v=rms(a)>1e-6?Math.min(4,Math.max(0.25,rms(b)/rms(a))):1; mkCache={key,v}; window.__makeup={A_rms:rms(a),B_rms:rms(b),gain:v}; return v; }
  catch(e){ return 1; } }
function wav24(ch,N){ const nc=2,len=N*nc*3,b=new ArrayBuffer(44+len),v=new DataView(b); let p=0;
  const str=s=>{for(const c of s) v.setUint8(p++,c.charCodeAt(0));}, u32=x=>{v.setUint32(p,x,true);p+=4}, u16=x=>{v.setUint16(p,x,true);p+=2};
  str("RIFF");u32(36+len);str("WAVE");str("fmt ");u32(16);u16(1);u16(nc);u32(SR);u32(SR*nc*3);u16(nc*3);u16(24);str("data");u32(len);
  for(let i=0;i<N;i++) for(let c=0;c<nc;c++){ let x=Math.round(Math.max(-1,Math.min(1,ch[c][i]))*8388607); if(x<0)x+=16777216; v.setUint8(p++,x&255);v.setUint8(p++,(x>>8)&255);v.setUint8(p++,(x>>16)&255); }
  return new Uint8Array(b); }
const takeLabel = t => `${t.name} (${t.muted?"muted":t.mode==="loop"?"loop":"silent"})`;
function midiFile(st){
  const PPQ=480,T=PPQ/4, total=st.bars*STEPS*T, vlq=n=>{const a=[n&127]; while(n>>=7) a.unshift((n&127)|128); return a;};
  const trk=evs=>{ evs.sort((a,b)=>a.t-b.t||a.o-b.o); let last=0; const d=[]; for(const e of evs){ d.push(...vlq(e.t-last),...e.b); last=e.t; }
    d.push(...vlq(Math.max(0,total-last)),0xFF,0x2F,0); return [0x4D,0x54,0x72,0x6B,(d.length>>>24)&255,(d.length>>16)&255,(d.length>>8)&255,d.length&255,...d]; };
  const meta=(type,s)=>{ const c=[...new TextEncoder().encode(s)]; return [0xFF,type,...vlq(c.length),...c]; }, name=s=>meta(0x03,s), us=Math.round(60000000/st.bpm);
  const cond=[{t:0,o:0,b:name(APP+" "+keyLabel()+" "+[0,1,2,3].map(chordName).join(" "))},{t:0,o:1,b:[0xFF,0x51,3,(us>>16)&255,(us>>8)&255,us&255]},{t:0,o:2,b:[0xFF,0x58,4,4,2,24,8]}];
  for(let b=0;b<st.bars;b++) cond.push({t:b*STEPS*T,o:3,b:meta(0x06,chordName(b%4))}); // chord-name markers every bar
  const tracks=[trk(cond)];
  const add=(evs,ch,note,t0,t1,vel)=>{ const v=Math.max(1,Math.round(vel*110)); evs.push({t:t0,o:2,b:[0x90|ch,note,v]}); evs.push({t:Math.max(t0+1,Math.min(total,t1)),o:1,b:[0x80|ch,note,0]}); };
  for(const c of CHAIRS.filter(c=>c.ch>=0)){ const evs=[{t:0,o:0,b:name(c.name)}];
    for(let s=0;s<st.bars*STEPS;s++) for(const ev of stepEvents(s,st,prog)) if(ev.part===c.id) add(evs,c.ch,ev.note,s*T,(s+ev.dur)*T,ev.vel);
    tracks.push(trk(evs)); }
  for(const tk of takes){ const evs=[{t:0,o:0,b:name("Heard chords: "+takeLabel(tk)+" · "+tk.chords.join(" "))}];
    for(let b=0;b<st.bars;b++){ const c=parseChord(tk.chords[b%4]); if(!c) continue; const r=inRange(48+pc(c.root-48),48,59); evs.push({t:b*STEPS*T,o:1.5,b:meta(0x01,tk.chords[b%4])});
      for(const iv of c.ivs) add(evs,4,r+iv,b*STEPS*T,(b+1)*STEPS*T,0.7); }
    tracks.push(trk(evs)); }
  return new Uint8Array([].concat([0x4D,0x54,0x68,0x64,0,0,0,6,0,1,0,tracks.length,PPQ>>8,PPQ&255],...tracks));
}
const fileBase = st => `${APP}-${st.recipe}-${st.bpm}bpm-${keyLabel()}`;
function download(bytes,name,type){ const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([bytes],{type})); a.download=name; document.body.appendChild(a); a.click(); a.remove(); }
async function exportWavBytes(o){ const r=await renderLoop(Object.assign({withTakes:state.wavTakes},o)); return {bytes:wav24(r.ch,r.N), name:fileBase(r.st)+".wav", frames:r.N}; }
function exportMidBytes(o){ const st=merged(o); return {bytes:midiFile(st), name:fileBase(st)+".mid"}; }
function crc32(b){ let c,crc=-1; for(let i=0;i<b.length;i++){ c=(crc^b[i])&255; for(let k=0;k<8;k++) c=c&1?(c>>>1)^0xEDB88320:c>>>1; crc=(crc>>>8)^c; } return (crc^-1)>>>0; }
function zipStore(fl){ const parts=[], cen=[]; let off=0; const enc=new TextEncoder();
  const le=(n,w)=>{ const a=[]; for(let i=0;i<w;i++) a.push((n>>>(8*i))&255); return a; };
  for(const f of fl){ const nm=enc.encode(f.name), c=crc32(f.bytes), sz=f.bytes.length;
    const h=new Uint8Array([0x50,0x4B,3,4,20,0,0,0,0,0,0,0,0x21,0,...le(c,4),...le(sz,4),...le(sz,4),...le(nm.length,2),0,0,...nm]);
    parts.push(h,f.bytes); cen.push(new Uint8Array([0x50,0x4B,1,2,20,0,20,0,0,0,0,0,0,0,0x21,0,...le(c,4),...le(sz,4),...le(sz,4),...le(nm.length,2),0,0,0,0,0,0,0,0,0,0,0,0,...le(off,4),...nm]));
    off+=h.length+sz; }
  const cl=cen.reduce((a,x)=>a+x.length,0), end=new Uint8Array([0x50,0x4B,5,6,0,0,0,0,...le(fl.length,2),...le(fl.length,2),...le(cl,4),...le(off,4),0,0]);
  const out=new Uint8Array(off+cl+end.length); let p=0; for(const x of [...parts,...cen,end]){ out.set(x,p); p+=x.length; } return out; }
const takeBase = t => `${APP}-take${t.n}-${t.bpm}bpm-${(t.chords[0]||"C").replace("#","s")}`;
async function exportTakeBytes(t){ // one take's dry audio: exactly 4 bars, 48 kHz/24-bit stereo, downbeat at sample 0
  if(!audioStore.has(t.id)) throw new Error(`${t.name} has no audio (keys/MIDI-only take)`);
  const r=await renderLoop({bpm:t.bpm,bars:LOOP_BARS,onlyTake:t,stem:true}); return {name:takeBase(t)+".wav", bytes:wav24(r.ch,r.N), frames:r.N}; }
async function exportStemsBytes(){ const list=takes.filter(t=>audioStore.has(t.id)); if(!list.length) throw new Error("No audio takes to export yet");
  const fl=[]; for(const t of list) fl.push(await exportTakeBytes(t));
  return {files:fl, zip:zipStore(fl), name:`${APP}-takes-${state.bpm}bpm-${keyLabel()}.zip`}; }

// ---------- license gate (Lemon Squeezy License API) ----------
// PLACEHOLDERS until Mark creates the Lemon Squeezy product (license keys ON): paste checkoutUrl, storeId, productId.
// While storeId/productId are null NO key unlocks anything.
const LEMON = { checkoutUrl: "", storeId: null, productId: null, price: "$19 once" };
window.__lemon=LEMON;
const LS_API="https://api.lemonsqueezy.com/v1/licenses/";
const lic = JSON.parse(localStorage.getItem(APP+"-license")||'{"valid":false}');
const configured = () => !!(LEMON.storeId && LEMON.productId);
async function lsCall(action, params){ const r=await fetch(LS_API+action,{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(params).toString()}); return r.json(); }
const ours = j => !!j && j.meta && +j.meta.store_id===+LEMON.storeId && +j.meta.product_id===+LEMON.productId;
async function activateKey(key){
  if(!configured()) return {ok:false, reason:"Checkout is not live yet. License keys cannot be checked until the store is set up."};
  const j=await lsCall("activate",{license_key:key, instance_name:"EarFour "+(navigator.platform||"web")});
  if(!j.activated) return {ok:false, reason:j.error||"That key could not be activated."};
  if(!ours(j)){ if(j.instance) lsCall("deactivate",{license_key:key, instance_id:j.instance.id}).catch(()=>{}); return {ok:false, reason:"That key is for a different product."}; }
  return {ok:true, instance:j.instance.id}; }
async function validateKey(key, instance){ if(!configured()) return false; const j=await lsCall("validate", instance?{license_key:key, instance_id:instance}:{license_key:key}); return !!j.valid && ours(j); }
function saveLic(){ localStorage.setItem(APP+"-license",JSON.stringify(lic)); }
const licUI = () => { document.getElementById("licOff").hidden=!lic.valid; document.getElementById("licState").textContent = lic.valid ? "Licensed: 8 and 16-bar band WAV unlocked." : `Free demo: the ear, recording, all takes, playback, MIDI export, take WAVs, MIDI I/O and a 4-bar band WAV. A license (${LEMON.price}) unlocks 8 and 16-bar band WAVs.`; };
const gated = () => !lic.valid && state.bars>4;

// ---------- Web MIDI ----------
let midiAccess=null, midiOut=null, midiInPort=null;
function midiSend(ev,time,sd){ if(!midiOut||!ctx) return; const c=CHAIRS.find(x=>x.id===ev.part); if(!c||c.ch<0) return; const at=performance.now()+(time-ctx.currentTime)*1000, v=Math.max(1,Math.round(ev.vel*110));
  midiOut.send([0x90|c.ch,ev.note,v],at); midiOut.send([0x80|c.ch,ev.note,0],at+ev.dur*sd*1000-5); }
function onMidi(e){ const d=e.data, s=d[0], cmd=s&0xF0, n=d[1], v=d[2];
  // Transport: only MIDI realtime Start/Continue/Stop, and only if opted in. Notes never touch transport.
  if(s===0xFA||s===0xFB){ if(state.midiTransport&&!playing) ensureCtx().then(()=>start("full")); return; }
  if(s===0xFC){ if(state.midiTransport&&playing) stop(); return; }
  if(s>=0xF0) return;
  if(cmd===0xB0&&n===64){ setSustain(v>=64); return; }
  if(cmd===0xB0&&(n===123||n===120)){ liveAllOff(); return; }
  if(cmd===0x90&&v>0) liveOn(n,v/127,"midi"); else if(cmd===0x80||(cmd===0x90&&v===0)) liveOff(n,"midi"); }
function refreshMidi(){ if(!midiAccess) return;
  const fill=(sel,ports,cur)=>{ sel.innerHTML='<option value="">(none)</option>'+[...ports.values()].map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join(""); sel.value=[...ports.keys()].includes(cur)?cur:""; };
  fill(ui.midiIn,midiAccess.inputs,state.midiIn); fill(ui.midiOut,midiAccess.outputs,state.midiOut);
  if(midiInPort) midiInPort.onmidimessage=null; midiInPort=midiAccess.inputs.get(ui.midiIn.value)||null; if(midiInPort) midiInPort.onmidimessage=onMidi;
  midiOut=midiAccess.outputs.get(ui.midiOut.value)||null;
  ui.midiNote.textContent = midiAccess.inputs.size ? (midiInPort?`Playing from ${midiInPort.name}. Velocity and sustain pedal (CC64) work; notes never start the band.`:"Pick your controller above.") : "No MIDI controller found. Plug one in; it shows up here."; }

// ---------- live play-along (keys / MIDI) -> "Your playing"; while recording, notes also go to the ear ----------
const liveVoices=new Map(); let sustain=false; window.__liveLog=[];
const setStatus=t=>{ const el=document.getElementById("status"); el.className="status"; el.textContent=t; };
function oneVoice(id, n, vg, t){ const r=pick(id,n), smp=liveBufs[id][r], buf=smp.buf, rate=Math.pow(2,(n-r)/12), g=ctx.createGain(); g.connect(bus.you);
  const s=ctx.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate;
  if(HOLD(id)){ s.loop=true; s.loopStart=Math.min(1.0,buf.duration*0.4); s.loopEnd=buf.duration-0.05; }
  s.connect(g); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(vg,t+(ATK[id]||0.003));
  s.start(t,smp.offset); if(!HOLD(id)) s.stop(t+(buf.duration-smp.offset)/rate); return {s,g}; }
function liveOn(note,vel,src){
  if(!ctx||ctx.state!=="running"||!liveBufs){ setStatus("Tap to start audio first, then play."); return; }
  const key=src+":"+note, t=ctx.currentTime;
  if(liveVoices.has(key)){ releaseVoice(liveVoices.get(key),t); recNoteOff(key,t); }
  const vg=Math.max(0.05,Math.pow(vel,1.2)), id=state.liveInst, n=inRange(note,RANGE[id][0],RANGE[id][1]);
  const vo={parts:[oneVoice(id,n,vg,t)],id,vg,sustained:false,done:false};
  vo.parts[0].s.onended=()=>{ vo.done=true; if(liveVoices.get(key)===vo) liveVoices.delete(key); };
  liveVoices.set(key,vo); keyVis(note,true); recNoteOn(key,vel,note,t);
  window.__liveLog.push({ev:"on",note,vel,vg,src,inst:id,played:n,startAt:t,ctxNow:ctx.currentTime,playing}); if(window.__liveLog.length>500) window.__liveLog.shift();
}
function releaseVoice(vo,t){ if(vo.done) return; vo.done=true; const rel=Math.max(0.01,REL[vo.id]||0.1);
  for(const p of vo.parts){ const g=p.g.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value,t); g.linearRampToValueAtTime(0,t+rel); try{ p.s.stop(t+rel+0.02); }catch(e){} } }
function liveOff(note,src){ const key=src+":"+note, vo=liveVoices.get(key); keyVis(note,false);
  window.__liveLog.push({ev:"off",note,src,ctxNow:ctx?ctx.currentTime:0,sustain});
  if(!vo) return; if(sustain){ vo.sustained=true; return; } liveVoices.delete(key); releaseVoice(vo,ctx.currentTime); recNoteOff(key,ctx.currentTime); }
function setSustain(down){ sustain=down; if(!down&&ctx) for(const [k,vo] of [...liveVoices]) if(vo.sustained){ liveVoices.delete(k); releaseVoice(vo,ctx.currentTime); recNoteOff(k,ctx.currentTime); } }
function liveAllOff(){ if(!ctx) return; for(const [k,vo] of liveVoices){ releaseVoice(vo,ctx.currentTime); recNoteOff(k,ctx.currentTime); } liveVoices.clear(); sustain=false; document.querySelectorAll(".down").forEach(k=>k.classList.remove("down")); }

// ---------- audio input: device choice, trim, clip light, noise gate, monitoring; captured on the audio clock ----------
const CAPTURE_SRC = `class EarCap extends AudioWorkletProcessor{ constructor(){ super(); this.gate=false; this.th=0.003; this.env=0; this.g=1; this.rec=false; this.pk=0; this.n=0;
  this.port.onmessage=e=>Object.assign(this,e.data); }
  process(ins,outs){ const i=ins[0]&&ins[0][0], o=outs[0]; if(!i) return true; const y=new Float32Array(i.length);
    for(let k=0;k<i.length;k++){ const a=Math.abs(i[k]); this.env=Math.max(a,this.env*0.9995); const tg=(!this.gate||this.env>this.th)?1:0; this.g+=(tg-this.g)*(tg>this.g?0.02:0.0008); y[k]=i[k]*this.g; if(a>this.pk) this.pk=a; }
    for(const ch of o) ch.set(y);
    if(this.rec){ const c=y.slice(0); this.port.postMessage({f:currentFrame, d:c}, [c.buffer]); }
    if(++this.n>=16){ this.port.postMessage({pk:this.pk}); this.pk=0; this.n=0; } return true; } }
registerProcessor("earcap", EarCap);`;
let mic=null, capChunks=[], peakHold=0, clipUntil=0;
const dbToGain = d => Math.pow(10,d/20);
async function enableMic(){
  await ensureCtx(); if(mic) return true;
  try{
    // only deviceId + all browser processing OFF (a music input, not a call)
    const c = {echoCancellation:false, noiseSuppression:false, autoGainControl:false}; if(state.audioIn) c.deviceId={exact:state.audioIn};
    const stream = await navigator.mediaDevices.getUserMedia({audio:c});
    if(!ctx.__earcap){ await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE_SRC],{type:"application/javascript"}))); ctx.__earcap=true; }
    const src=ctx.createMediaStreamSource(stream), trim=ctx.createGain(), node=new AudioWorkletNode(ctx,"earcap",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]}), mon=ctx.createGain();
    trim.gain.value=dbToGain(state.trimDb); mon.gain.value=state.monitor?1:0; src.connect(trim); trim.connect(node); node.connect(mon); mon.connect(bus.you);
    node.port.onmessage=e=>{ const m=e.data; if(m.pk!==undefined){ peakHold=Math.max(m.pk,peakHold*0.85); if(m.pk>=0.98) clipUntil=performance.now()+1200; if(!playing) paintMeter(); return; } capChunks.push(m); };
    const tr=stream.getAudioTracks()[0], s=tr.getSettings?tr.getSettings():{};
    mic={stream,src,trim,node,mon,inLat:typeof s.latency==="number"?s.latency:0.01,label:tr.label};
    node.port.postMessage({gate:state.gate, th:dbToGain(state.gateDb)});
    ui.micState.textContent=`Mic on: ${tr.label||"default input"} · ${ctx.sampleRate} Hz · echo cancel, noise suppression and auto gain OFF`;
    ui.micBtn.textContent="Turn mic off"; listDevices(); return true;
  }catch(e){ ui.micState.textContent=`Mic not available (${e.name}). You can still play chords on a MIDI keyboard or the on-screen keys.`; return false; }
}
function disableMic(){ if(!mic) return; mic.stream.getTracks().forEach(t=>t.stop()); try{ mic.src.disconnect(); mic.node.disconnect(); }catch(e){} mic=null; ui.micState.textContent="Mic off."; ui.micBtn.textContent="Turn mic on"; peakHold=0; paintMeter(); }
function paintMeter(){ const m=document.getElementById("meterBar"), cl=document.getElementById("clip"); if(!m) return;
  const db=peakHold>1e-5?20*Math.log10(peakHold):-90; m.style.width=Math.max(0,Math.min(100,(db+60)/60*100))+"%"; cl.classList.toggle("on",performance.now()<clipUntil); }
const latencyS = () => (ctx ? (ctx.outputLatency||ctx.baseLatency||0) : 0) + (mic?mic.inLat:0) + state.latencyFixMs/1000;
function sliceCapture(t0, dur){ // samples for [t0, t0+dur) on the audio clock, shifted by the round-trip latency
  const sr=ctx.sampleRate, n=Math.round(dur*sr), out=new Float32Array(n), f0=Math.round((t0+latencyS())*sr);
  for(const c of capChunks){ const a=c.f-f0; if(a+c.d.length<=0||a>=n) continue; for(let i=Math.max(0,-a);i<c.d.length&&a+i<n;i++) out[a+i]=c.d[i]; }
  return out; }

// ---------- the looping recorder: every loop pass -> a new take (heard chords + dry audio) ----------
let recPasses=[], recNotes=[], openNotes=new Map(), recUsesMic=false;
function recNoteOn(key,vel,note,t){ if(mode!=="rec") return; const h={note,vel,on:t,off:null}; recNotes.push(h); openNotes.set(key,h); }
function recNoteOff(key,t){ const h=openNotes.get(key); if(!h) return; openNotes.delete(key); h.off=t; }
function finishPass(p){ p.done=true; const barS=16*p.sd, t0=p.time, useMic=recUsesMic&&state.listen!=="midi", useMidi=state.listen!=="mic";
  const sr=ctx.sampleRate, audio = useMic ? sliceCapture(t0, 4*barS) : null;
  const pcmBars = audio ? [0,1,2,3].map(b=>chromaFromPcm(audio.subarray(Math.round((b*barS+0.03)*sr), Math.round((b+1)*barS*sr)), sr)) : null;
  const noteBars = useMidi ? [0,1,2,3].map(b=>chromaFromNotes(recNotes, t0+b*barS-0.08, t0+(b+1)*barS-0.08)) : null;
  const heard=hearBars(pcmBars, noteBars, state.vocab); recNotes=recNotes.filter(n=>n.off===null||n.off>t0+4*barS-0.1);
  if(!heard.some(Boolean)){ setStatus(`Pass ${p.pass}: heard nothing loud enough. Turn up the mic trim or play on the keys.`); return; }
  const hasAudio = !!audio && pcmBars.some(x=>x.rms>=MIN_RMS), fromMidi=heard.some(h=>h&&h.from!=="mic");
  addTake(heard, fillGaps(heard,[0,1,2,3].map(chordName)), hasAudio?{data:audio,sr}:null, fromMidi?(hasAudio?"mic + keys":"keys/MIDI"):"mic"); }
function recTick(){ for(const p of recPasses) if(!p.done && ctx.currentTime > p.time + L*p.sd + latencyS() + 0.15) finishPass(p);
  const keep=ctx.currentTime-30; capChunks = capChunks.filter(c=>c.f/ctx.sampleRate > keep); }
function addTake(heard, chords, audio, src){
  if(takes.length>=TAKE_CAP){ setStatus(`Take limit (${TAKE_CAP}) reached, this pass was not kept. Export or delete takes to record more.`); return null; }
  const n=takes.reduce((m,t)=>Math.max(m,t.n),0)+1;
  if(!state.layer) for(const t of takes) if(t.mode==="loop") t.mode="silent"; // newest take loops; older ones go silent unless Layer is on
  const tk={id:Date.now()+"-"+n,n,name:"Take "+n,mode:"loop",muted:false,src,bpm:state.bpm,key:state.keyRoot,chords,heard:heard.map(h=>h?{name:h.name,conf:h.conf,from:h.from}:null),hasAudio:!!audio};
  takes.push(tk); if(audio){ audioStore.set(tk.id,audio); putAudio(tk.id,audio); }
  if(state.autoUse) useChords(tk, true); tk.key=state.keyRoot; saveTakes(); renderTakes(); return tk; }
function useChords(tk, quiet){ const p=parseProg(tk.chords.join(" ")); if(!p) return; prog=p; state.chords=tk.chords.join(" "); state.keyRoot=p[0].root; save(); syncInputs(); render();
  if(!quiet) setStatus(`Band now plays ${tk.name}'s chords: ${state.chords}.`); }
async function startRec(){
  await ensureCtx(); if(!liveBufs) return; stop();
  recUsesMic = state.listen==="midi" ? false : await enableMic();
  if(!recUsesMic && state.listen==="mic"){ setStatus("Mic is off, so the ear has nothing to hear. Allow the mic or set “Hear chords from” to keys/MIDI."); return; }
  recPasses=[]; recNotes=[]; openNotes=new Map(); capChunks=[]; if(mic) mic.node.port.postMessage({rec:recUsesMic});
  bus.ab.gain.setValueAtTime(1, ctx.currentTime);
  const bd=4*60/state.bpm, T0=ctx.currentTime+0.15+bd;
  for(let i=0;i<4;i++) voice(ctx, liveBufs, bus.chairs.kit, {src:"kit",note:i?42:38,dur:1,vel:i?0.6:0.85}, T0-bd+i*bd/4, 60/state.bpm/4, true); // 1-bar count-in
  mode="rec"; nextStepTime=T0; step=0; stepLog.length=0; playing=true; passNo=0; ui.bpm.disabled=true;
  timerId=setInterval(scheduler, LOOKAHEAD_MS); requestAnimationFrame(draw); paintDock();
  setStatus("Recording: one bar count-in, then play ONE chord per bar for 4 bars. Every 4-bar pass becomes a new take. Press Stop when done.");
}
function finishRec(stopAt){
  for(const [k] of [...openNotes]) recNoteOff(k,stopAt);
  for(const p of recPasses) if(!p.done && stopAt>=p.time+L*p.sd-0.05) finishPass(p); // only whole passes become takes
  recPasses=[]; capChunks=[]; if(mic) mic.node.port.postMessage({rec:false}); ui.bpm.disabled=false;
  setStatus(takes.length?`${takes.length} take${takes.length>1?"s":""}. The band follows the newest take's chords${state.autoUse?"":" when you press “Use chords”"}. Press B to hear it.`:"Nothing recorded. Press ● Record and play after the count-in.");
}
// first-run demo: render 4 bars of real piano chords offline, run them through the SAME ear, keep the result as a take
async function runDemo(){
  await ensureCtx(); if(!liveBufs) return; stop(); setStatus("Demo: rendering 4 bars of piano chords (Dm Bb F C) and letting the ear listen…");
  const barS=4*60/state.bpm, sr=ctx.sampleRate, n=Math.round(4*barS*sr), oc=new OfflineAudioContext(1,n,sr), bufs=await decodeAll(oc), g=oc.createGain(); g.gain.value=0.5; g.connect(oc.destination);
  const DEMO=[[50,57,62,65],[46,53,58,62],[41,57,60,65],[48,55,60,64]];
  DEMO.forEach((v,b)=>{ for(const k of [0,8]) for(const nn of v) voice(oc,bufs,g,{src:"piano",note:nn,dur:8,vel:k?0.55:0.7},b*barS+k*barS/16,barS/16,false); });
  const x=(await oc.startRendering()).getChannelData(0).slice(0);
  const pcmBars=[0,1,2,3].map(b=>chromaFromPcm(x.subarray(Math.round(b*barS*sr),Math.round((b+1)*barS*sr)),sr)), heard=hearBars(pcmBars,null,state.vocab);
  const tk=addTake(heard, fillGaps(heard,["Dm","Bb","F","C"]), {data:x,sr}, "demo: rendered piano through the ear");
  if(tk){ tk.name="Demo take"; saveTakes(); renderTakes(); window.__demo={heard:tk.heard,chords:tk.chords};
    setStatus(`The ear heard: ${tk.chords.join(" ")} (played: Dm Bb F C). The band now plays those chords. This is the Demo take; delete it any time.`); start("full"); }
}

// ---------- audio devices: input (getUserMedia deviceId) and output (AudioContext.setSinkId) ----------
const sinkOK = () => typeof (window.AudioContext||function(){}).prototype.setSinkId === "function";
async function listDevices(){ const sel=ui.audioOut, note=ui.audioOutNote, isel=ui.audioIn; let devs=[];
  try{ devs=await navigator.mediaDevices.enumerateDevices(); }catch(e){}
  const ins=devs.filter(d=>d.kind==="audioinput"&&d.deviceId&&d.deviceId!=="default");
  isel.innerHTML='<option value="">System default input</option>'+ins.map((d,i)=>`<option value="${esc(d.deviceId)}">${esc(d.label||"Audio input "+(i+1))}</option>`).join(""); isel.value=ins.some(d=>d.deviceId===state.audioIn)?state.audioIn:"";
  if(!sinkOK()){ sel.innerHTML='<option value="">System default</option>'; sel.disabled=true; note.textContent="This browser can't route Web Audio to a chosen device (no AudioContext.setSinkId). Sound goes to your system output."; return; }
  const outs=devs.filter(d=>d.kind==="audiooutput"&&d.deviceId&&d.deviceId!=="default");
  sel.innerHTML='<option value="">System default</option>'+outs.map((d,i)=>`<option value="${esc(d.deviceId)}">${esc(d.label||"Audio output "+(i+1))}</option>`).join("");
  sel.value=outs.some(d=>d.deviceId===state.audioOut)?state.audioOut:""; if(sel.value!==state.audioOut&&state.audioOut) note.textContent="Saved output is not connected; using system default.";
  else if(outs.length && !outs[0].label) note.textContent="Device names show after you allow the mic once; until then they are numbered."; }
async function applySink(){ if(!ctx||!sinkOK()) return; const note=ui.audioOutNote;
  try{ const want=state.audioOut||""; if((typeof ctx.sinkId==="string"?ctx.sinkId:"")!==want) await ctx.setSinkId(want); note.textContent = state.audioOut ? "Playing through the selected output." : "Playing through the system default output."; }
  catch(e){ note.textContent="Could not switch output ("+e.name+"); staying on the system default."; state.audioOut=""; save(); ui.audioOut.value=""; } }
if(navigator.mediaDevices&&navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange",listDevices);

// ---------- UI ----------
const ui={}; ["audioOut","audioOutNote","audioIn","micState","micBtn","trim","trimLbl","gate","gateDb","monitor","latFix","latLbl","listen","autoUse","vocab","bpm","key","chords","chordErr","bars","recClick","layer",
  "midiIn","midiOut","midiNote","midiTransport","liveInst","youGain","bandGain","master","wavTakes","licKey","licBtn","tap","tapBtn","takes","takeInfo","bars4","miniKeys","liveHint","liveOctLbl","guide"].forEach(id=>ui[id]=document.getElementById(id));
ui.key.innerHTML=NAMES.map((n,i)=>`<option value="${i}">${n}</option>`).join("");
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function syncInputs(){ ui.bpm.value=state.bpm; ui.key.value=state.keyRoot; if(document.activeElement!==ui.chords) ui.chords.value=state.chords; ui.bars.value=state.bars;
  ui.recClick.checked=state.recClick; ui.layer.checked=state.layer; ui.listen.value=state.listen; ui.autoUse.checked=state.autoUse; ui.vocab.value=state.vocab;
  ui.trim.value=state.trimDb; ui.trimLbl.textContent=(state.trimDb>0?"+":"")+state.trimDb+" dB"; ui.gate.checked=state.gate; ui.gateDb.value=state.gateDb; ui.monitor.checked=state.monitor;
  ui.latFix.value=state.latencyFixMs; ui.latLbl.textContent=(state.latencyFixMs>0?"+":"")+state.latencyFixMs+" ms";
  ui.midiTransport.checked=state.midiTransport; ui.liveInst.value=state.liveInst; ui.youGain.value=state.youGain; ui.bandGain.value=state.bandGain; ui.master.value=state.master; ui.wavTakes.checked=state.wavTakes; }
function onChords(){ const p=parseProg(ui.chords.value); if(!p){ ui.chordErr.textContent="Exactly 4 chords, e.g. Am F C G (m, 7, m7, maj7, dim, sus2, sus4)"; return; }
  ui.chordErr.textContent=""; prog=p; state.chords=ui.chords.value.trim(); state.keyRoot=p[0].root; ui.key.value=state.keyRoot; save(); render(); }
function cards(id, list, on, label, click){ const el=document.getElementById(id); el.innerHTML="";
  list.forEach(x=>{ const b=document.createElement("button"); b.className="card"+(on(x)?" on":""); b.dataset.id=x.id; b.innerHTML=label(x); b.onclick=()=>click(x); el.appendChild(b); }); }
function paintGrooves(){ cards("grooves",grooves,g=>state.groove===g.id,g=>`<b>${g.name}</b><span>${g.bpm} BPM · ${g.chords}</span>`,
  g=>{ if(mode==="rec") return; state.groove=g.id; state.bpm=g.bpm; state.chords=g.chords; prog=parseProg(g.chords); state.keyRoot=prog[0].root; save(); syncInputs(); render(); }); }
function paintRecipes(){ cards("recipes",recipes,r=>state.recipe===r.id,r=>`<b>${r.name}</b><span>${r.blurb}</span>`,r=>{ state.recipe=r.id; save(); render(); }); }
function paintChairs(){ const el=document.getElementById("chairs"); el.innerHTML="";
  CHAIRS.forEach(c=>{ const d=document.createElement("div"); d.className="chair"+(state.mutes[c.id]?" muted":"");
    d.innerHTML=`<label><input type="checkbox" data-mute="${c.id}" ${state.mutes[c.id]?"checked":""}/> Mute</label><div>${c.name}</div><input type="range" min="0" max="1" step="0.01" data-gain="${c.id}" value="${state.gains[c.id]}" aria-label="${c.name} level"/>`; el.appendChild(d); }); }
function paintBars(){ const latest=[...takes].reverse().find(t=>t.heard&&t.chords.join(" ")===state.chords);
  ui.bars4.innerHTML=[0,1,2,3].map(b=>{ const h=latest&&latest.heard[b];
    return `<div class="bar4"><div class="ph"></div><span class="n">bar ${b+1}</span><b class="c">${esc(chordName(b))}</b><small>${h?`heard ${esc(h.name)} · ${esc(h.from)} · ${Math.round(h.conf*100)}% sure`:latest?"filled from the bar before":"from your chord entry"}</small></div>`; }).join(""); }
function renderTakes(){
  ui.takeInfo.textContent=takes.length?`${takes.length} take${takes.length>1?"s":""} (max ${TAKE_CAP}). Loop takes play their dry audio every pass (only at the BPM and key they were played in). Each take exports on its own.`:"No takes yet. Press ● Record, play one chord per bar after the count-in, and every 4-bar pass becomes a take. Or press ▶ Hear the demo.";
  ui.takes.innerHTML=takes.map((t,i)=>{ const a=audioStore.has(t.id), fits=audioFits(t);
   return `<div class="take${audible(t)?" aud":""}" data-i="${i}">
   <input class="tname" value="${esc(t.name)}" data-act="name" aria-label="Take name">
   <small><b>${esc(t.chords.join(" "))}</b> · ${esc(t.src)} · ${t.bpm} BPM${a?(fits?" · audio":" · audio sits out (band is at another BPM or key)"):(t.hasAudio?" · audio not loaded":" · no audio")}</small>
   <select data-act="mode" aria-label="Loop or silent"><option value="loop"${t.mode==="loop"?" selected":""}>Loop</option><option value="silent"${t.mode==="silent"?" selected":""}>Silent</option></select>
   <label class="chk"><input type="checkbox" data-act="mute"${t.muted?" checked":""}> Mute</label>
   <button data-act="use">Use chords</button><button data-act="wav"${a?"":" disabled"}>WAV</button><button data-act="del">Delete</button></div>`; }).join("");
  paintBars(); }
ui.takes.addEventListener("change",e=>{ const row=e.target.closest(".take"); if(!row) return; const t=takes[+row.dataset.i], a=e.target.dataset.act;
  if(a==="mode") t.mode=e.target.value; if(a==="mute") t.muted=e.target.checked; if(a==="name") t.name=e.target.value.trim()||("Take "+t.n); saveTakes(); renderTakes(); });
ui.takes.addEventListener("click",async e=>{ const a=e.target.dataset.act; if(!["del","use","wav"].includes(a)) return; const i=+e.target.closest(".take").dataset.i, t=takes[i];
  if(a==="use"){ useChords(t); return; }
  if(a==="wav"){ try{ const r=await exportTakeBytes(t); download(r.bytes,r.name,"audio/wav"); setStatus("Saved "+r.name); }catch(err){ setStatus(err.message); } return; }
  if(!confirm(`Delete ${t.name}? This can't be undone.`)) return; takes.splice(i,1); audioStore.delete(t.id); delAudio(t.id); saveTakes(); renderTakes(); });
function paintDock(){ for(const id of ["recBtn","recBtn2"]){ const b=document.getElementById(id); if(b){ b.textContent = mode==="rec" ? "■ Stop recording" : "● Record"; b.classList.toggle("recording",mode==="rec"); } } }
// on-screen keys + computer keys
const KEYMAP="awsedftgyhujkolp;'"; const kbBase=()=>12*(state.liveOct+1);
function renderKeys(){ const base=kbBase();
  ui.miniKeys.innerHTML=[...Array(KEYMAP.length)].map((_,i)=>{ const n=base+i, blk=[1,3,6,8,10].includes(i%12);
    return `<button class="mk ${blk?"blk":"wht"}" data-n="${n}" aria-label="${NAMES[n%12]}${Math.floor(n/12)-1}"><span>${NAMES[n%12]}</span><i>${KEYMAP[i].toUpperCase()}</i></button>`; }).join("");
  ui.liveOctLbl.textContent="C"+state.liveOct; updateHint(true); }
function keyVis(n,on){ const k=document.querySelector(`.mk[data-n="${n}"]`); if(k) k.classList.toggle("down",on); }
let hintKey="";
function curBar(){ if(!playing||!ctx) return 0; const now=ctx.currentTime; let cur=null; for(const e of stepLog){ if(e.time<=now) cur=e; else break; } return cur?cur.bar:0; }
function updateHint(force){ const b=curBar(), k=b+"|"+state.keyRoot+state.chords+mode; if(k===hintKey&&!force) return; hintKey=k;
  const c=chordAtBar(b,state,prog);
  ui.liveHint.innerHTML = mode==="rec" ? `Recording: play your chord for <b>bar ${b+1}</b>.` : `Now <b>${chordName(b%4)}</b>: chord tones <b>${c.tones.map(t=>NAMES[t]).join(" ")}</b> are lit. Hold a chord here while recording and the ear reads it exactly.`;
  document.querySelectorAll(".mk").forEach(el=>{ const p=pc(+el.dataset.n); el.classList.toggle("tone",c.tones.includes(p)); el.classList.toggle("root",p===c.tones[0]); }); }
function pointerKeys(box, sel){ const down=new Map();
  box.addEventListener("pointerdown",e=>{ const k=e.target.closest(sel); if(!k) return; e.preventDefault(); const n=+k.dataset.n; down.set(e.pointerId,n); liveOn(n,100/127,"tap"); });
  const up=e=>{ if(!down.has(e.pointerId)) return; liveOff(down.get(e.pointerId),"tap"); down.delete(e.pointerId); };
  box.addEventListener("pointerup",up); box.addEventListener("pointercancel",up); box.addEventListener("pointerleave",up); box.addEventListener("contextmenu",e=>e.preventDefault()); }
pointerKeys(ui.miniKeys,".mk");
document.addEventListener("keydown",e=>{ if(e.repeat||e.metaKey||e.ctrlKey||e.altKey) return; const tg=e.target.tagName; if(tg==="INPUT"||tg==="SELECT"||tg==="TEXTAREA") return;
  const k=e.key.toLowerCase();
  if(k==="z"||k==="x"){ state.liveOct=Math.max(1,Math.min(6,state.liveOct+(k==="z"?-1:1))); save(); renderKeys(); return; }
  const i=KEYMAP.indexOf(k); if(i>=0){ e.preventDefault(); liveOn(kbBase()+i,100/127,"kb"); } });
document.addEventListener("keyup",e=>{ const i=KEYMAP.indexOf(e.key.toLowerCase()); if(i>=0) liveOff(kbBase()+i,"kb"); });
window.addEventListener("blur",()=>{ for(const [k] of [...liveVoices]) if(/^(kb|tap):/.test(k)) liveOff(+k.split(":")[1],k.split(":")[0]); });

function render(){ updateHint(true); paintGrooves(); paintRecipes(); paintChairs(); renderTakes(); }
ui.bpm.addEventListener("change",()=>{ const v=Math.round(+ui.bpm.value); if(!(v>=60&&v<=180)||mode==="rec"){ ui.bpm.value=state.bpm; return; } state.bpm=v; save(); render(); });
ui.key.addEventListener("change",()=>{ state.keyRoot=+ui.key.value; save(); render(); });
ui.chords.addEventListener("change",onChords);
ui.bars.addEventListener("change",()=>{ state.bars=+ui.bars.value; save(); });
for(const [id,k] of [["listen","listen"],["vocab","vocab"]]) ui[id].addEventListener("change",()=>{ state[k]=ui[id].value; save(); });
for(const [id,k] of [["autoUse","autoUse"],["recClick","recClick"],["layer","layer"],["wavTakes","wavTakes"],["midiTransport","midiTransport"]]) ui[id].addEventListener("change",()=>{ state[k]=ui[id].checked; save(); });
ui.micBtn.addEventListener("click",async()=>{ if(mic) disableMic(); else await enableMic(); });
ui.audioIn.addEventListener("change",async()=>{ state.audioIn=ui.audioIn.value; save(); if(mic){ disableMic(); await enableMic(); } });
ui.trim.addEventListener("input",()=>{ state.trimDb=Math.max(-24,Math.min(12,+ui.trim.value)); ui.trimLbl.textContent=(state.trimDb>0?"+":"")+state.trimDb+" dB"; if(mic) mic.trim.gain.setTargetAtTime(dbToGain(state.trimDb),ctx.currentTime,0.02); save(); });
ui.gate.addEventListener("change",()=>{ state.gate=ui.gate.checked; if(mic) mic.node.port.postMessage({gate:state.gate}); save(); });
ui.gateDb.addEventListener("change",()=>{ state.gateDb=+ui.gateDb.value; if(mic) mic.node.port.postMessage({th:dbToGain(state.gateDb)}); save(); });
ui.monitor.addEventListener("change",()=>{ state.monitor=ui.monitor.checked; if(mic) mic.mon.gain.setTargetAtTime(state.monitor?1:0,ctx.currentTime,0.02); save(); });
ui.latFix.addEventListener("input",()=>{ state.latencyFixMs=+ui.latFix.value; ui.latLbl.textContent=(state.latencyFixMs>0?"+":"")+state.latencyFixMs+" ms"; save(); });
ui.liveInst.addEventListener("change",()=>{ liveAllOff(); state.liveInst=ui.liveInst.value; save(); renderKeys(); });
for(const [id,node] of [["youGain","you"],["bandGain","band"],["master","master"]])
  ui[id].addEventListener("input",()=>{ state[id]=+ui[id].value; if(bus) bus[node].gain.setTargetAtTime(state[id],ctx.currentTime,0.01); save(); });
document.getElementById("liveOctDn").addEventListener("click",()=>{ state.liveOct=Math.max(1,state.liveOct-1); save(); renderKeys(); });
document.getElementById("liveOctUp").addEventListener("click",()=>{ state.liveOct=Math.min(6,state.liveOct+1); save(); renderKeys(); });
ui.midiIn.addEventListener("change",()=>{ state.midiIn=ui.midiIn.value; save(); refreshMidi(); });
ui.midiOut.addEventListener("change",()=>{ state.midiOut=ui.midiOut.value; save(); refreshMidi(); });
ui.audioOut.addEventListener("change",e=>{ state.audioOut=e.target.value; save(); applySink(); });
document.getElementById("chairs").addEventListener("input",e=>{ const m=e.target.dataset.mute, g=e.target.dataset.gain;
  if(m){ state.mutes[m]=e.target.checked; e.target.closest(".chair").classList.toggle("muted",e.target.checked); }
  if(g){ state.gains[g]=+e.target.value; if(bus) bus.chairs[g].gain.setTargetAtTime(state.gains[g],ctx.currentTime,0.01); }
  save(); });
document.getElementById("clearTakes").addEventListener("click",()=>{ if(!takes.length||!confirm(`Clear all ${takes.length} takes? This can't be undone.`)) return; for(const t of takes){ audioStore.delete(t.id); delAudio(t.id); } takes.length=0; saveTakes(); renderTakes(); });
const go = m => async () => { await ensureCtx(); start(m); };
document.getElementById("playA").onclick=go("thin");
document.getElementById("playB").onclick=go("full");
document.getElementById("stop").onclick=stop;
document.getElementById("demoBtn").onclick=()=>{ state.seenGuide=true; save(); runDemo(); };
document.getElementById("guideHide").onclick=()=>{ state.seenGuide=true; save(); ui.guide.open=false; };
const recClick = ()=>{ if(mode==="rec"){ stop(); return; } startRec(); };
document.getElementById("recBtn").onclick=recClick; document.getElementById("recBtn2").onclick=recClick;
document.getElementById("exportWav").onclick=async()=>{ if(gated()){ setStatus("Free demo exports a 4-bar band WAV. Set Length to 4 bars, or unlock below for 8/16 bars."); return; }
  setStatus("Rendering…"); try{ const r=await exportWavBytes(); download(r.bytes,r.name,"audio/wav"); setStatus("Saved "+r.name); }catch(e){ setStatus("Export failed: "+e.message); } };
document.getElementById("exportMid").onclick=()=>{ const r=exportMidBytes(); download(r.bytes,r.name,"audio/midi"); setStatus("Saved "+r.name+" (band tracks, a heard-chords track per take, chord markers)"); };
document.getElementById("exportStems").addEventListener("click",async()=>{ setStatus("Rendering take WAVs…"); try{ const r=await exportStemsBytes(); download(r.zip,r.name,"application/zip"); setStatus(`Saved ${r.name} (${r.files.length} take WAVs)`); }catch(e){ setStatus("Take export failed: "+e.message); } });
ui.tapBtn.onclick=async()=>{ ui.tapBtn.textContent="Starting…"; await ensureCtx(); if(ctx.state==="running") ui.tap.classList.add("hide"); showLoad(); };
ui.licBtn.onclick=async()=>{ const k=ui.licKey.value.trim(); if(!k) return; const st=document.getElementById("licState"); st.textContent="Checking…";
  try{ const r=await activateKey(k); if(r.ok){ Object.assign(lic,{valid:true,key:k,instance:r.instance,checked:Date.now()}); saveLic(); licUI(); } else st.textContent=r.reason; }
  catch(e){ st.textContent="Could not reach Lemon Squeezy. Check your connection and try again."; } };
document.getElementById("licOff").onclick=async()=>{ if(lic.key&&lic.instance&&configured()) await lsCall("deactivate",{license_key:lic.key,instance_id:lic.instance}).catch(()=>{}); for(const k of Object.keys(lic)) delete lic[k]; lic.valid=false; saveLic(); licUI(); };
{ const buy=document.getElementById("buy"); if(LEMON.checkoutUrl){ buy.href=LEMON.checkoutUrl; buy.textContent="Buy EarFour · "+LEMON.price; } else { buy.removeAttribute("href"); buy.setAttribute("aria-disabled","true"); buy.textContent="Checkout opening soon · "+LEMON.price; } }
if(lic.valid&&lic.key) validateKey(lic.key,lic.instance).then(v=>{ lic.valid=v; lic.checked=Date.now(); saveLic(); licUI(); }).catch(()=>{});
if(/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1)) document.querySelectorAll(".ios").forEach(e=>e.hidden=false);
ui.guide.open=!state.seenGuide;
window.__earfour = { state, stepEvents, detectChord, chromaFromPcm, chromaFromNotes, hearBars, addTake, exportWavBytes, exportMidBytes, exportStemsBytes, exportTakeBytes, loadAll, start:m=>start(m), stop, startRec, runDemo, enableMic, files, takes, audioStore,
  liveOn, liveOff, setSustain, voices:liveVoices, get bus(){return bus;}, get mic(){return mic;}, get sustain(){return sustain;}, get playing(){return playing;}, get mode(){return mode;}, get ctx(){return ctx;}, get missing(){return [...missing];}, get lic(){return lic;} };
syncInputs(); renderKeys(); render(); licUI(); showLoad(); paintDock(); listDevices(); loadAudio();
if(navigator.requestMIDIAccess) navigator.requestMIDIAccess().then(a=>{ midiAccess=a; a.onstatechange=refreshMidi; refreshMidi(); }).catch(()=>{ ui.midiNote.textContent="Web MIDI unavailable or blocked in this browser."; });
else ui.midiNote.textContent="Web MIDI not supported in this browser (try Chrome/Edge). The on-screen and computer keys still play.";

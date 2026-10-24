import asyncio, base64, json, sys, io, wave, zipfile, mido
from playwright.async_api import async_playwright
URL=sys.argv[1]; OUT=sys.argv[2] if len(sys.argv)>2 else 'extra.json'
LOADED="/seated (\\d+)\\/\\1/.test(document.getElementById('status').textContent)"
MOCK="""(()=>{window.__sent=[]; const inp={id:'fake-in',name:'Fake Keys',type:'input',state:'connected',onmidimessage:null};
const out={id:'fake-out',name:'Fake Synth',type:'output',state:'connected',send:(d,t)=>window.__sent.push([Array.from(d),t||0])};
const acc={inputs:new Map([['fake-in',inp]]),outputs:new Map([['fake-out',out]]),onstatechange:null,sysexEnabled:false};
navigator.requestMIDIAccess=()=>Promise.resolve(acc);
window.__midi=(d)=>{ if(inp.onmidimessage) inp.onmidimessage({data:new Uint8Array(d)}); return !!inp.onmidimessage; };
if(!localStorage.getItem('wordfour-settings')) localStorage.setItem('wordfour-settings', JSON.stringify({midiIn:'fake-in',midiOut:'fake-out'}));})()"""
SINK="""(()=>{ window.__sinkCalls=[]; AudioContext.prototype.setSinkId=function(id){ window.__sinkCalls.push(id); Object.defineProperty(this,'sinkId',{value:id,configurable:true}); return Promise.resolve(); };
  navigator.mediaDevices.enumerateDevices=()=>Promise.resolve([{kind:'audiooutput',deviceId:'default',label:'Default'},{kind:'audiooutput',deviceId:'hp1',label:'Studio Headphones'}]); })()"""
def wavinfo(b):
  w=wave.open(io.BytesIO(b)); return {'sr':w.getframerate(),'bits':w.getsampwidth()*8,'frames':w.getnframes()}
LAST="()=>window.__liveLog.filter(e=>e.ev==='on').pop()"
async def main():
  r={}
  async with async_playwright() as p:
    br=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    c=await br.new_context(); pg=await c.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    await pg.add_init_script(MOCK); await pg.add_init_script(SINK)
    await pg.goto(URL); await pg.click('#tapBtn'); await pg.wait_for_function(LOADED,timeout=120000); await pg.wait_for_timeout(600)
    # ===== words -> syllables (deterministic) =====
    r['syllabifier']=await pg.evaluate("()=>{const B=window.__wordfour; return {words:Object.fromEntries(['tonight','lonely','hopeless','waiting','home','coming','another','yellow','lonely','river','morning','breathe','wanted','hoped','to-night','beautiful'].map(w=>[w,B.splitWord(w)])), default_lyric:B.syllables(B.state.lyrics).map(s=>(s.strong?'*':'')+s.text).join(' ')}}")
    s1=await pg.evaluate("()=>JSON.stringify(window.__wordfour.sketchNotes(window.__wordfour.state,null,'arch'))") if False else None
    r['sketch']=await pg.evaluate("()=>{const B=window.__wordfour, d=B.DEMO(); const ns=d.notes; const a=JSON.stringify(ns); return {notes:ns.length, first:ns.slice(0,6).map(n=>[n.pos,n.text,n.note]), stressed_on_beat:ns.filter((n,i)=>B.syllables(B.state.lyrics)[n.syl].strong).every(n=>n.pos%2===0), in_range:ns.every(n=>n.note>=52&&n.note<=76), within_loop:ns.every(n=>n.pos>=0&&n.pos+n.len<=64)}}")
    # ===== MIDI in: words mode =====
    m={'midi_in_select':await pg.eval_on_selector('#midiIn','e=>e.value'),'midi_out_select':await pg.eval_on_selector('#midiOut','e=>e.value'),'live_mode':await pg.eval_on_selector('#liveInst','e=>e.value')}
    lat=[]
    for n in [48,60,72,62,64,65]:
      x=await pg.evaluate("""(n)=>new Promise(res=>{ const B=window.__wordfour; const t0=performance.now(); window.__midi([0x90,n,100]);
        const vo=B.voices.get('midi:'+n); const c=B.ctx; const an=c.createAnalyser(); an.fftSize=256; vo.parts[0].g.connect(an);
        const buf=new Float32Array(256); let k=0; const iv=setInterval(()=>{ an.getFloatTimeDomainData(buf); let mx=0; for(const v of buf) mx=Math.max(mx,Math.abs(v));
          if(mx>1e-4||++k>400){ clearInterval(iv); const e=window.__liveLog.filter(e=>e.ev==='on').pop(); res({played:n,sung:e.sung,syllable:e.text,ms_to_audio:+(performance.now()-t0).toFixed(2),sched_delay_ms:(e.startAt-e.ctxNow)*1000}); } },1); })""", n)
      lat.append(x); await pg.wait_for_timeout(120); await pg.evaluate("(n)=>window.__midi([0x80,n,0])", n)
    m['each_key_sings_next_syllable']=lat
    m['velocity_gain_v20_v127']=[await pg.evaluate("()=>{window.__midi([0x90,61,20]); const v=window.__wordfour.voices.get('midi:61').vg; window.__midi([0x80,61,0]); return v}"), await pg.evaluate("()=>{window.__midi([0x90,61,127]); const v=window.__wordfour.voices.get('midi:61').vg; window.__midi([0x80,61,0]); return v}")]
    await pg.evaluate("()=>{window.__midi([0x90,60,100]);}"); await pg.wait_for_timeout(100)
    m['held_while_key_down']=await pg.evaluate("()=>window.__wordfour.voices.has('midi:60')")
    await pg.evaluate("()=>{window.__midi([0x90,64,100]);}"); await pg.wait_for_timeout(50)
    m['mono_new_note_cuts_old']=await pg.evaluate("()=>!window.__wordfour.voices.has('midi:60')&&window.__wordfour.voices.has('midi:64')")
    await pg.evaluate("()=>{window.__midi([0x80,60,0]);window.__midi([0x80,64,0])}"); await pg.wait_for_timeout(300)
    m['released_on_noteoff']=not await pg.evaluate("()=>window.__wordfour.voices.has('midi:64')")
    await pg.evaluate("()=>{window.__midi([0xB0,64,127]);window.__midi([0x90,62,90]);window.__midi([0x80,62,0]);}"); await pg.wait_for_timeout(400)
    held=await pg.evaluate("()=>window.__wordfour.voices.has('midi:62')"); await pg.evaluate("()=>window.__midi([0xB0,64,0])"); await pg.wait_for_timeout(300)
    m['sustain']={'held_after_noteoff_with_pedal':held,'released_on_pedal_up':not await pg.evaluate("()=>window.__wordfour.voices.has('midi:62')")}
    await pg.click('#resetWords')
    await pg.select_option('#liveInst','piano'); await pg.evaluate("()=>window.__midi([0x90,64,100])"); await pg.wait_for_timeout(100)
    m['piano_note_mode']=await pg.evaluate(LAST); await pg.evaluate("()=>window.__midi([0x80,64,0])")
    await pg.select_option('#liveInst','pad'); await pg.evaluate("()=>window.__midi([0x90,64,100])"); await pg.wait_for_timeout(4000)
    m['pad_held_4s']=await pg.evaluate("()=>{const v=window.__wordfour.voices.get('midi:64'); return !!v&&!v.done&&v.parts[0].g.gain.value>0.1}"); await pg.evaluate("()=>window.__midi([0x80,64,0])")
    await pg.select_option('#liveInst','voice'); await pg.evaluate("()=>window.__midi([0x90,67,100])"); await pg.wait_for_timeout(3000)
    m['voice_note_held_3s']=await pg.evaluate("()=>{const v=window.__wordfour.voices.get('midi:67'); return !!v&&!v.done&&v.parts[0].g.gain.value>0.1}"); await pg.evaluate("()=>window.__midi([0x80,67,0])")
    await pg.select_option('#liveInst','words')
    m['notes_started_transport']=await pg.evaluate("()=>window.__wordfour.playing")
    await pg.evaluate("()=>window.__midi([0xFA])"); await pg.wait_for_timeout(300); m['start_msg_ignored_when_off']=not await pg.evaluate("()=>window.__wordfour.playing")
    await pg.check('#midiTransport'); await pg.evaluate("()=>window.__midi([0xFA])"); await pg.wait_for_timeout(800); m['start_msg_starts_when_on']=await pg.evaluate("()=>window.__wordfour.playing")
    n0=await pg.evaluate("()=>window.__schedLog.length"); s0=await pg.evaluate("()=>window.__sent.length")
    for i in range(10):
      await pg.evaluate("(n)=>window.__midi([0x90,n,90])",60+i%5); await pg.wait_for_timeout(90); await pg.evaluate("(n)=>window.__midi([0x80,n,0])",60+i%5); await pg.wait_for_timeout(200)
    await pg.wait_for_timeout(400); log=await pg.evaluate("()=>window.__schedLog"); bpm=await pg.evaluate("()=>window.__wordfour.state.bpm")
    times=[e['time'] for e in log[n0:]]; sd=60/bpm/4
    m['scheduler_during_live']={'steps':len(times),'max_step_dev_ms':round(max(abs((b-a)-sd) for a,b in zip(times,times[1:]))*1000,4)}
    m['live_syllables_while_playing']=await pg.evaluate("()=>window.__liveLog.filter(e=>e.ev==='on').slice(-10).map(e=>e.text)")
    sent=await pg.evaluate("()=>window.__sent"); notes=[s[0] for s in sent[s0:] if (s[0][0]&0xF0)==0x90]
    m['midi_out_while_playing']={'note_ons':len(notes),'bass_ch1':sum(1 for x in notes if x[0]==0x90),'piano_ch2':sum(1 for x in notes if x[0]==0x91),'pad_ch3':sum(1 for x in notes if x[0]==0x92),'melody_ch4':sum(1 for x in notes if x[0]==0x93),'kit_ch10':sum(1 for x in notes if x[0]==0x99)}
    await pg.evaluate("()=>window.__midi([0xFC])"); await pg.wait_for_timeout(300); m['stop_msg_stops']=not await pg.evaluate("()=>window.__wordfour.playing")
    await pg.uncheck('#midiTransport'); await pg.click('#resetWords')
    await pg.click('body',position={'x':5,'y':5}); 
    for k in 'adg': await pg.keyboard.down(k); await pg.wait_for_timeout(60); await pg.keyboard.up(k)
    m['computer_keys_a_d_g']=await pg.evaluate("()=>window.__liveLog.filter(e=>e.ev==='on'&&e.src==='kb').map(e=>[e.note,e.text])")
    key=pg.locator('.mk').nth(4); await key.scroll_into_view_if_needed(); await key.click(); await pg.wait_for_timeout(50)
    m['onscreen_key']=await pg.evaluate("()=>window.__liveLog.filter(e=>e.ev==='on'&&e.src==='tap').map(e=>[e.note,e.text])")
    opts=await pg.eval_on_selector_all('#audioOut option','e=>e.map(o=>o.textContent)'); await pg.select_option('#audioOut','hp1'); await pg.wait_for_timeout(300)
    m['output_select']={'options':opts,'sinkCalls':await pg.evaluate('window.__sinkCalls'),'note':await pg.text_content('#audioOutNote'),'persisted':json.loads(await pg.evaluate("localStorage.getItem('wordfour-settings')"))['audioOut']}
    m['no_audio_input_requested']=await pg.evaluate("()=>fetch('app.js').then(r=>r.text()).then(t=>!/getUserMedia/.test(t))")
    m['errors']=errs; r['midi']=m
    # ===== Looping recorder: MIDI notes, 3 passes -> 3 takes, each pass restarts from the first word =====
    t={}
    await pg.evaluate("()=>{const e=document.getElementById('bpm');e.value=150;e.dispatchEvent(new Event('change'))}")
    await pg.evaluate("()=>window.__wordfour.startRec()"); await pg.wait_for_function("()=>window.__wordfour.mode==='rec'",timeout=10000)
    t['status_rec']=await pg.text_content('#status'); t['bpm_locked']=await pg.is_disabled('#bpm')
    plan=[[(60,0,2),(64,1,1)],[(57,0.5,1),(60,1.5,2),(62,2.5,1)],[(64,0.25,4)]]  # (note, beat, hold beats)
    for pi,hits in enumerate(plan):
      for n,beat,hold in hits:
        await pg.wait_for_function(f"()=>{{const p=window.__wordfour.tpos(); return p&&p.pass==={pi+1}&&p.pos>={beat*4}}}",timeout=20000)
        await pg.evaluate("(n)=>window.__midi([0x90,n,100])",n); await pg.wait_for_timeout(int(hold*60/150*1000)); await pg.evaluate("(n)=>window.__midi([0x80,n,0])",n)
      if pi<2: await pg.wait_for_function(f"()=>{{const p=window.__wordfour.tpos(); return p&&p.pass==={pi+2}}}",timeout=20000)
    await pg.wait_for_timeout(800); await pg.click('#stop'); await pg.wait_for_timeout(500)
    tk=await pg.evaluate("()=>window.__wordfour.takes.map(t=>({n:t.n,mode:t.mode,src:t.src,notes:t.notes.map(h=>[h.pos,h.len,h.note,h.text])}))")
    t['takes']=tk; t['separate_takes']=len(tk)==3 and [len(x['notes']) for x in tk]==[2,3,1]
    t['each_take_starts_at_first_word']=[x['notes'][0][3] for x in tk]
    t['modes_newest_loop_older_silent']=[x['mode'] for x in tk]
    t['hold_lengths_steps_expected_8_4_4_8_4_16']=[round(h[1],2) for x in tk for h in x['notes']]
    t['all_notes_in_bounds']=all(0<=h[0]<64 and h[0]+h[1]<=64.001 for x in tk for h in x['notes'])
    await pg.evaluate("()=>{window.__wordfour.takes[0].mode='loop';}")
    mid=await pg.evaluate("()=>{const r=window.__wordfour.exportMidBytes({bars:4}); return {name:r.name,b:Array.from(r.bytes)}}")
    mf=mido.MidiFile(file=io.BytesIO(bytes(mid['b'])))
    t['midi']={'name':mid['name'],'type':mf.type,'ppq':mf.ticks_per_beat,'tracks':[tr.name for tr in mf.tracks],'length_s':round(mf.length,4),
      'lyrics_per_take':[[x.text for x in tr if x.type=='lyrics'] for tr in mf.tracks if tr.name.startswith('Melody')]}
    sh=await pg.evaluate("()=>{const r=window.__wordfour.exportSheetBytes({bars:4}); return {name:r.name,text:new TextDecoder().decode(r.bytes)}}")
    t['sheet']={'name':sh['name'],'head':sh['text'].split('\n')[:7]}
    st=await pg.evaluate("""async()=>{const r=await window.__wordfour.exportStemsBytes({bars:4}); let s=''; for(let i=0;i<r.zip.length;i+=32768) s+=String.fromCharCode.apply(null,r.zip.subarray(i,i+32768)); return {name:r.name,b64:btoa(s)}}""")
    z=zipfile.ZipFile(io.BytesIO(base64.b64decode(st['b64']))); t['stems']={'zip':st['name'],'testzip_ok':z.testzip() is None,'files':{n:wavinfo(z.read(n)) for n in z.namelist()}}
    await pg.reload(); await pg.wait_for_timeout(1500); t['takes_survive_reload']=await pg.evaluate("()=>window.__wordfour.takes.length")
    t['settings_survive_reload']=await pg.evaluate("()=>[window.__wordfour.state.bpm,document.getElementById('bpm').value]")
    t['errors']=errs; r['takes']=t; await c.close()
    # ===== License (mocked Lemon Squeezy API) =====
    L={}
    c=await br.new_context(); pg=await c.new_page()
    async def lsroute(route):
      req=route.request; body=req.post_data or ''; key=dict(x.split('=') for x in body.split('&') if '=' in x).get('license_key','')
      meta={'store_id':111,'product_id':222} if key.startswith('GOOD') else {'store_id':999,'product_id':222} if key.startswith('WRONGSTORE') else {'store_id':111,'product_id':333}
      if req.url.endswith('/activate'): j={'activated':not key.startswith('BAD'),'error':None if not key.startswith('BAD') else 'license_key not found','instance':{'id':'inst-1'},'meta':meta}
      elif req.url.endswith('/validate'): j={'valid':key.startswith('GOOD') and not key.endswith('REVOKED'),'meta':meta}
      else: j={'deactivated':True,'meta':meta}
      await route.fulfill(status=200,content_type='application/json',body=json.dumps(j),headers={'Access-Control-Allow-Origin':'*'})
    await pg.route('https://api.lemonsqueezy.com/**', lsroute)
    await pg.goto(URL); await pg.click('#tapBtn'); await pg.wait_for_function(LOADED,timeout=120000)
    L['buy_unconfigured']=await pg.text_content('#buy'); L['buy_has_href']=await pg.evaluate("()=>document.getElementById('buy').hasAttribute('href')")
    await pg.fill('#licKey','GOOD-KEY'); await pg.click('#licBtn'); await pg.wait_for_timeout(400)
    L['unconfigured_key']=await pg.text_content('#licState'); L['unconfigured_unlocked']=await pg.evaluate("()=>window.__wordfour.lic.valid")
    await pg.evaluate("()=>{window.__wordfour.state.bars=8}"); await pg.click('#exportWav'); await pg.wait_for_timeout(300); L['demo_gate_8bar_wav']=await pg.text_content('#status')
    await pg.evaluate("(cfg)=>{ window.__lemon.storeId=cfg.store; window.__lemon.productId=cfg.product; }",{'store':111,'product':222})
    for k in ['BAD-KEY','WRONGSTORE-KEY','OTHERPRODUCT-KEY','GOOD-KEY']:
      await pg.fill('#licKey',k); await pg.click('#licBtn'); await pg.wait_for_timeout(400); L[k]={'state':await pg.text_content('#licState'),'valid':await pg.evaluate("()=>window.__wordfour.lic.valid")}
    await pg.click('#licOff'); await pg.wait_for_timeout(300); L['after_remove_valid']=await pg.evaluate("()=>window.__wordfour.lic.valid")
    await pg.evaluate("()=>localStorage.setItem('wordfour-license',JSON.stringify({valid:true,key:'GOOD-REVOKED',instance:'inst-1'}))")
    await pg.add_init_script("(()=>{const t=setInterval(()=>{ if(window.__lemon){ window.__lemon.storeId=111; window.__lemon.productId=222; clearInterval(t);} },0);})()")
    await pg.reload(); await pg.wait_for_timeout(1500); L['revoked_relocks_on_reload']=not await pg.evaluate("()=>window.__wordfour.lic.valid")
    r['license']=L; await c.close()
    # ===== Mobile =====
    for dev in ['iPhone 13','Pixel 7']:
      d=p.devices[dev]; c=await br.new_context(**{k:v for k,v in d.items() if k!='default_browser_type'},accept_downloads=True); mp=await c.new_page(); me=[]; mp.on('pageerror',lambda e:me.append(str(e)))
      await mp.goto(URL); await mp.wait_for_timeout(800)
      x={'gate_visible_before_tap':await mp.is_visible('#tapBtn'),'ios_note_visible':await mp.is_visible('#tap .ios')}
      await mp.screenshot(path=f"mobile_{dev.replace(' ','_')}.png")
      await mp.tap('#tapBtn'); await mp.wait_for_function(LOADED,timeout=120000); await mp.wait_for_timeout(400)
      x['gate_hidden_after_tap']=await mp.is_hidden('#tap'); x['ctx_state']=await mp.evaluate("window.__wordfour.ctx.state")
      x['overflow_px']=await mp.evaluate("document.documentElement.scrollWidth-innerWidth")
      await mp.tap('#lyrics'); await mp.fill('#lyrics','hold me close\nin the dark-ness'); await mp.wait_for_timeout(200)
      x['typed_lyric_syllables']=await mp.evaluate("()=>window.__wordfour.syllables(window.__wordfour.state.lyrics).map(s=>s.text).join(' ')")
      await mp.tap('#playB'); await mp.wait_for_timeout(1500); x['playing']=await mp.evaluate("window.__wordfour.playing")
      k=mp.locator('.mk').nth(0); await k.scroll_into_view_if_needed(); await k.tap(); await mp.wait_for_timeout(50); x['key_tap_sang']=await mp.evaluate("window.__liveLog.filter(e=>e.src==='tap'&&e.ev==='on').map(e=>e.text)")
      x['key_w_px']=round((await mp.locator('.mk.wht').first.bounding_box())['width'],1)
      await mp.tap('#stop'); x['stopped']=not await mp.evaluate("window.__wordfour.playing")
      nt=mp.locator('.nt').first; await nt.scroll_into_view_if_needed(); x['grid_note_w_px']=round((await nt.bounding_box())['width'],1)
      await mp.evaluate("()=>{const e=document.getElementById('bars'); e.value='4'; e.dispatchEvent(new Event('change'))}")
      async with mp.expect_download(timeout=60000) as dl: await mp.tap('#exportWav')
      dd=await dl.value; x['wav_download']=dd.suggested_filename
      await mp.evaluate("window.scrollTo(0,0)"); await mp.screenshot(path=f"mobile_{dev.replace(' ','_')}_full.png",full_page=True)
      x['errors']=me; r[dev]=x; await c.close()
    print(json.dumps(r,indent=1)); json.dump(r,open(OUT,'w'),indent=1); await br.close()
asyncio.run(main())

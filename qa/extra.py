import asyncio, json, sys
from playwright.async_api import async_playwright
URL=sys.argv[1]; R={}
LOADED="/seated (\\d+)\\/\\1/.test(document.getElementById('status').textContent)"
async def m():
  async with async_playwright() as p:
    b=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture=/tmp/qa/dm.wav'])
    c=await b.new_context(viewport={'width':1100,'height':900},permissions=['microphone'],accept_downloads=True)
    await c.add_init_script("""
      window.__sent=[]; const mkIn={id:'in1',name:'Mock Keys',onmidimessage:null}; const mkOut={id:'out1',name:'Mock Out',send:(d,t)=>window.__sent.push(Array.from(d))};
      navigator.requestMIDIAccess=async()=>({inputs:new Map([['in1',mkIn]]),outputs:new Map([['out1',mkOut]]),onstatechange:null}); window.__mkIn=mkIn;
      window.__sinks=[]; AudioContext.prototype.setSinkId=async function(id){ window.__sinks.push(id); Object.defineProperty(this,'sinkId',{value:id,configurable:true}); };
      const oe=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices); navigator.mediaDevices.enumerateDevices=async()=>[...(await oe()),{kind:'audiooutput',deviceId:'spk2',label:'Studio Monitors',groupId:'g'}];
      const og=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia=async(c)=>{ window.__gum=c; return og(c); };
    """)
    pg=await c.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    await pg.goto(URL); R['guide_open_first_run']=await pg.evaluate("document.getElementById('guide').open")
    await pg.click('#tapBtn'); await pg.wait_for_function(LOADED,timeout=120000)
    R['ctx_rate']=await pg.evaluate("window.__earfour.ctx.sampleRate")
    # demo
    await pg.click('#demoBtn'); await pg.wait_for_function("window.__demo",timeout=60000); R['demo']=await pg.evaluate("window.__demo")
    R['demo_band_chords']=await pg.evaluate("window.__earfour.state.chords"); R['demo_playing']=await pg.evaluate("window.__earfour.mode")
    await pg.click('#stop'); await pg.screenshot(path='demo.png',full_page=True)
    # midi in: notes must not start transport, velocity, sustain
    await pg.select_option('#midiIn','in1'); await pg.select_option('#midiOut','out1')
    await pg.evaluate("window.__mkIn.onmidimessage({data:new Uint8Array([0x90,60,40])})"); await pg.wait_for_timeout(100)
    R['midi_note_started_transport']=await pg.evaluate("window.__earfour.playing")
    R['midi_vel']=await pg.evaluate("window.__liveLog.filter(e=>e.ev==='on'&&e.src==='midi').map(e=>[e.vel,e.vg])")
    await pg.evaluate("window.__mkIn.onmidimessage({data:new Uint8Array([0xB0,64,127])});window.__mkIn.onmidimessage({data:new Uint8Array([0x80,60,0])})")
    R['sustain_held']=await pg.evaluate("window.__earfour.voices.size")
    await pg.evaluate("window.__mkIn.onmidimessage({data:new Uint8Array([0xB0,64,0])})"); R['after_pedal_up']=await pg.evaluate("window.__earfour.voices.size")
    # computer key default velocity
    await pg.keyboard.down('a'); await pg.wait_for_timeout(50); await pg.keyboard.up('a'); R['kb_vel']=await pg.evaluate("window.__liveLog.filter(e=>e.src==='kb').map(e=>e.vel)[0]")
    # sink
    R['outputs']=await pg.evaluate("[...document.querySelectorAll('#audioOut option')].map(o=>o.textContent)")
    await pg.select_option('#audioOut','spk2'); await pg.wait_for_timeout(200); R['sinks']=await pg.evaluate("window.__sinks")
    # keys-only take: hold G B D during recording, set bpm 120 to be quick
    await pg.evaluate("()=>{const e=document.getElementById('bpm');e.value=120;e.dispatchEvent(new Event('change'))}")
    await pg.select_option('#listen','midi'); n0=await pg.evaluate("window.__earfour.takes.length")
    await pg.click('#recBtn'); await pg.wait_for_timeout(2300)
    for ch in [[55,59,62],[57,60,64],[53,57,60],[52,55,59]]:
      await pg.evaluate("ns=>ns.forEach(n=>window.__mkIn.onmidimessage({data:new Uint8Array([0x90,n,90])}))",ch); await pg.wait_for_timeout(1800)
      await pg.evaluate("ns=>ns.forEach(n=>window.__mkIn.onmidimessage({data:new Uint8Array([0x80,n,0])}))",ch); await pg.wait_for_timeout(200)
    await pg.wait_for_timeout(800); await pg.click('#recBtn')
    R['keys_take']=await pg.evaluate(f"window.__earfour.takes.slice({n0}).map(t=>[t.chords.join(' '),t.src,t.hasAudio])")
    R['band_after_keys']=await pg.evaluate("window.__earfour.state.chords")
    # mic take: fake Dm, 2 passes -> 2 takes
    await pg.select_option('#listen','mic'); n0=await pg.evaluate("window.__earfour.takes.length")
    await pg.click('#recBtn'); await pg.wait_for_timeout(2000+2*8000+1200); await pg.click('#recBtn'); await pg.wait_for_timeout(500)
    R['gum_constraints']=await pg.evaluate("window.__gum")
    R['mic_takes']=await pg.evaluate(f"window.__earfour.takes.slice({n0}).map(t=>[t.chords.join(' '),t.src,t.hasAudio,t.mode,t.heard.map(h=>h&&h.conf)])")
    R['mic_meter_width']=await pg.evaluate("document.getElementById('meterBar').style.width")
    # take export separately
    R['take_wav']=await pg.evaluate("(async()=>{const t=window.__earfour.takes.at(-1); const r=await window.__earfour.exportTakeBytes(t); return [r.name,r.frames]})()")
    R['stems']=await pg.evaluate("(async()=>{const r=await window.__earfour.exportStemsBytes(); return [r.name,r.files.map(f=>f.name),r.zip.length]})()")
    R['midi_tracks']=await pg.evaluate("(()=>{const b=window.__earfour.exportMidBytes({}).bytes; return (b[10]<<8)|b[11]})()")
    # A/B makeup
    await pg.click('#playA'); await pg.wait_for_timeout(1500); R['makeup']=await pg.evaluate("window.__makeup"); await pg.click('#stop')
    # license gate
    R['buy_text']=await pg.text_content('#buy'); R['buy_href']=await pg.get_attribute('#buy','href')
    await pg.fill('#licKey','TEST-KEY'); await pg.click('#licBtn'); await pg.wait_for_timeout(300); R['lic_msg']=await pg.text_content('#licState')
    await pg.select_option('#bars','8'); await pg.click('#exportWav'); await pg.wait_for_timeout(300); R['gated_status']=await pg.text_content('#status')
    # persistence reload
    await pg.reload(); await pg.click('#tapBtn'); await pg.wait_for_timeout(2500)
    R['after_reload']=await pg.evaluate("[window.__earfour.takes.length, window.__earfour.audioStore.size, window.__earfour.state.bpm, document.getElementById('guide').open]")
    await pg.screenshot(path='takes.png',full_page=True)
    R['errors']=errs
    # mobile
    for dev in ['iPhone 13','Pixel 7']:
      mc=await b.new_context(**p.devices[dev]); mp=await mc.new_page(); e2=[]; mp.on('pageerror',lambda e:e2.append(str(e)))
      await mp.goto(URL); await mp.tap('#tapBtn'); await mp.wait_for_function(LOADED,timeout=120000)
      vis=await mp.is_visible('#guide'); await mp.tap('#demoBtn'); await mp.wait_for_function("window.__demo",timeout=60000)
      ov=await mp.evaluate("document.documentElement.scrollWidth>window.innerWidth+1")
      await mp.screenshot(path=f"m-{dev.replace(' ','')}.png"); R[dev]={'guide':vis,'demo':await mp.evaluate("window.__demo.chords"),'h_overflow':ov,'ios_note':await mp.is_visible('.tap .ios') if dev=='iPhone 13' else None,'errors':e2}
      await mc.close()
    print(json.dumps(R,indent=1)); json.dump(R,open('ext.json','w'),indent=1); await b.close()
asyncio.run(m())

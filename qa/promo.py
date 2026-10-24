import asyncio, base64, json, sys, os
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'https://wordfour.vercel.app/'
LOADED="/seated (\\d+)\\/\\1/.test(document.getElementById('status').textContent)"
B64="""async (o)=>{const r=await window.__wordfour.exportWavBytes(o); let s=''; const b=r.bytes; for(let i=0;i<b.length;i+=32768) s+=String.fromCharCode.apply(null,b.subarray(i,i+32768)); return {name:r.name,b64:btoa(s)};}"""
KEYMAP="awsedftgyhujkolp;'"
async def main():
  os.makedirs('promo',exist_ok=True)
  async with async_playwright() as p:
    br=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    c=await br.new_context(viewport={'width':1280,'height':720},device_scale_factor=1); pg=await c.new_page()
    await pg.goto(URL); await pg.wait_for_timeout(800); await pg.screenshot(path='promo/s0_gate.png')
    await pg.click('#tapBtn'); await pg.wait_for_function(LOADED,timeout=120000); await pg.wait_for_timeout(500)
    await pg.evaluate("document.querySelector('#lyrics').scrollIntoView({block:'center'})"); await pg.wait_for_timeout(300); await pg.screenshot(path='promo/s1_words.png')
    # real recording: play the melody on the computer keys (C4 = A), one key per syllable, one 4-bar pass at 92 BPM
    await pg.click('#grooves [data-id=porch]'); await pg.click('body',position={'x':5,'y':5})
    plan=await pg.evaluate("()=>window.__wordfour.DEMO().notes.map(n=>[n.pos,n.len,n.note])")
    await pg.evaluate("()=>window.__wordfour.startRec()"); await pg.wait_for_function("()=>window.__wordfour.mode==='rec'")
    await pg.evaluate("document.querySelector('#karaoke').scrollIntoView({block:'start'})")
    sd=60/92/4
    for i,(pos,ln,note) in enumerate(plan):
      k=note-60
      while k<0: k+=12
      while k>=len(KEYMAP): k-=12
      await pg.wait_for_function(f"()=>{{const p=window.__wordfour.tpos(); return p&&p.pass===1&&p.pos>={pos}}}",timeout=30000)
      await pg.keyboard.down(KEYMAP[k])
      if i==7: await pg.screenshot(path='promo/s2_sing.png')
      await pg.wait_for_timeout(max(40,int(ln*sd*1000)-30)); await pg.keyboard.up(KEYMAP[k])
    await pg.wait_for_function("()=>{const p=window.__wordfour.tpos(); return p&&p.pass===2&&p.pos>=1}",timeout=30000); await pg.click('#stop'); await pg.wait_for_timeout(400)
    tk=await pg.evaluate("()=>window.__wordfour.takes.map(t=>t.notes.map(n=>n.text).join(' '))")
    await pg.evaluate("document.querySelector('#grid').scrollIntoView({block:'center'})"); await pg.click('#playB'); await pg.wait_for_timeout(2600); await pg.screenshot(path='promo/s3_grid.png')
    await pg.evaluate("document.querySelector('#karaoke').scrollIntoView({block:'start'})"); await pg.wait_for_timeout(1200); await pg.screenshot(path='promo/s4_karaoke.png')
    await pg.evaluate("document.querySelector('#takes').scrollIntoView({block:'center'})"); await pg.wait_for_timeout(400); await pg.screenshot(path='promo/s5_takes.png')
    await pg.click('#stop')
    r=await pg.evaluate(B64,{'bpm':92,'bars':8}); open('promo/'+r['name'].replace('.wav','-take1.wav'),'wb').write(base64.b64decode(r['b64']))
    m=await pg.evaluate("()=>{const r=window.__wordfour.exportMidBytes({bpm:92,bars:8}); let s=''; for(const x of r.bytes) s+=String.fromCharCode(x); return {name:r.name,b64:btoa(s)}}")
    open('promo/'+m['name'].replace('.mid','-take1.mid'),'wb').write(base64.b64decode(m['b64']))
    sh=await pg.evaluate("()=>{const r=window.__wordfour.exportSheetBytes({bpm:92,bars:8}); return {name:r.name,t:new TextDecoder().decode(r.bytes)}}")
    open('promo/'+sh['name'].replace('-lyrics.txt','-take1-lyrics.txt'),'w').write(sh['t'])
    await pg.click('#exportMid'); await pg.wait_for_timeout(300); await pg.evaluate("window.scrollTo(0,0)"); await pg.wait_for_timeout(300); await pg.screenshot(path='promo/s6_export.png')
    print(json.dumps({'takes':tk,'wav':r['name']})); await br.close()
asyncio.run(main())

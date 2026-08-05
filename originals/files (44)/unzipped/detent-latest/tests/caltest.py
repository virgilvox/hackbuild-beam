from playwright.sync_api import sync_playwright
import pathlib, math
url="file://"+str(pathlib.Path("detent-plot.html").resolve())
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1560,"height":980})
    errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.goto(url); pg.wait_for_timeout(1000)
    pg.evaluate("document.querySelectorAll('.grp').forEach(g=>g.classList.remove('collapsed'))")

    print("== free jog: limits off must not clamp ==")
    r=pg.evaluate("()=>{const o=[];[[9999,-9999],[50,50]].forEach(([a,c])=>o.push([clampX(a),clampY(c)]));return o}")
    print("  clamp with limits off:",r)

    print("== enforce asymmetric limits ==")
    pg.fill("#limMinX","-40"); pg.fill("#limMaxX","300")
    pg.fill("#limMinY","-120"); pg.fill("#limMaxY","90")
    pg.check("#limOn"); pg.wait_for_timeout(300)
    r=pg.evaluate("()=>[clampX(9999),clampX(-9999),clampY(9999),clampY(-9999)]")
    print("  clamped:",r,"expect [300,-40,90,-120]")

    print("== four corner solve ==")
    # simulate a rig mounted rotated and off-axis
    pg.evaluate("""()=>{
      S.corners=[[-150,140],[170,155],[165,-130],[-160,-145]];
      paintCorners();}""")
    pg.click("#bSolve"); pg.wait_for_timeout(400)
    out=pg.evaluate("""()=>{
      const r=[];
      for(let i=0;i<4;i++){const m=cornerMm(i);const g=mmToSteps(m[0],m[1]);
        r.push([m,g,S.corners[i]]);}
      return {rows:r, resid:S.resid, map:!!S.hom};}""")
    for m,got,want in out["rows"]:
        print("   mm",[round(v,1) for v in m],"-> steps",got,"want",want,
              "OK" if got==want else "MISMATCH")
    print("  residual",round(out["resid"],4),"mm | mapping active",out["map"])

    rt=pg.evaluate("""()=>{let w=0;
      for(let x=-60;x<=60;x+=10)for(let y=-60;y<=60;y+=10){
        const s=mmToSteps(x,y);const m=stepsToMm(s[0],s[1]);
        w=Math.max(w,Math.hypot(m[0]-x,m[1]-y));}
      return w;}""")
    print("  mm->steps->mm worst round trip:",round(rt,3),"mm")

    print("== limits derived from corners ==")
    pg.click("#bLimFromCorners"); pg.wait_for_timeout(300)
    print("  ",pg.evaluate("()=>[S.limMinX,S.limMaxX,S.limMinY,S.limMaxY,S.limOn]"),
          "expect [-164,174,-149,159,true]")

    print("== capture button drives the real path ==")
    pg.evaluate("S.corners=[null,null,null,null];S.armed=0;S.posX=-151;S.posY=141;paintCorners()")
    pg.click("#bCapture"); pg.wait_for_timeout(250)
    print("  captured:",pg.evaluate("()=>S.corners[0]"),
          "| armed advanced to:",pg.eval_on_selector("#vArmed","e=>e.textContent"),
          "| tile shows:",pg.eval_on_selector("#c0","e=>e.textContent"))
    pg.evaluate("S.corners=[[-150,140],[170,155],[165,-130],[-160,-145]];paintCorners()")
    pg.click("#bSolve"); pg.wait_for_timeout(300)

    print("== commands emitted ==")
    log=pg.eval_on_selector("#log","e=>[...e.children].map(c=>c.textContent).filter(t=>t.startsWith('> ')).join(' | ')")
    for c in ["Y ","N ","U ","P "]:
        print("  sends",repr(c.strip()),":", c in log)

    print("== invert does not transform the preview ==")
    before=pg.evaluate("()=>mmToSteps(40,25)")
    pg.check("#mInvX"); pg.check("#mInvY"); pg.wait_for_timeout(300)
    after=pg.evaluate("()=>mmToSteps(40,25)")
    sent=pg.eval_on_selector("#log","e=>e.textContent.includes('I 1 1')")
    print("  steps before",before,"after",after,"| I 1 1 sent to board:",sent)

    pg.click("#bClearCal"); pg.wait_for_timeout(300)
    print("  after clear, mapping:",pg.evaluate("()=>S.hom?'measured':'ideal'"))
    print("  corners after clear:",pg.evaluate("()=>S.corners"))
    b.close()
print("errors:",errs or "none")

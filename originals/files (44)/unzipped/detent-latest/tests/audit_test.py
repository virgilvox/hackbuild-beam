from playwright.sync_api import sync_playwright
import pathlib
url="file://"+str(pathlib.Path("detent-plot.html").resolve())
TESTSVG='''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<g transform="translate(10,10) rotate(15)">
 <rect x="0" y="0" width="30" height="20"/>
 <circle cx="60" cy="30" r="12"/>
</g>
<path d="M10 80 C 20 60, 40 60, 50 80 S 80 100, 90 80 Q 95 70 90 60 T 80 40 A 10 10 0 0 1 60 40 Z"/>
<polyline points="5,5 15,8 25,5"/>
</svg>'''
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1560,"height":980})
    errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.goto(url); pg.wait_for_timeout(900)
    pg.evaluate("document.querySelectorAll('.grp').forEach(g=>g.classList.remove('collapsed'))")

    print("== qc adopt: board config populates the app ==")
    pg.evaluate("""()=>{
      onLine("qc1 rate=350 travel=480 ramp=150 lashx=6 lashy=4 minx=-140 maxx=160 miny=-90 maxy=110 lon=1 invx=0 invy=1 throw=180 sep=22 fw=200 fh=90 idle=0");
      onLine("qc2 cs=15 c0=-150,140 c1=170,155 c2=165,-130 c3=-160,-145 map=1");
      onLine("qc3 h=0.009049,0.0002516,0.02427,0.0004705,0.007843,0.02287,-0.0000231788,0.000144292");
      onLine("qc4 end");}""")
    got=pg.evaluate("""()=>[
      +document.getElementById('mRate').value, +document.getElementById('limMaxX').value,
      document.getElementById('limOn').checked, document.getElementById('mInvY').checked,
      document.getElementById('mHold').checked, S.corners[2], !!S.hom]""")
    print("  rate,maxX,limOn,invY,hold,c2,map:",got)
    ok = got==[350,160,True,True,True,[165,-130],True]
    print("  ADOPT", "OK" if ok else "MISMATCH")

    print("== svg import ==")
    r=pg.evaluate("(t)=>{const st=svgToStrokes(t,0.4); "
                  "const flat=st.flat(); "
                  "return {n:st.length, pts:flat.length, fin:flat.every(p=>isFinite(p[0])&&isFinite(p[1])), "
                  "bw:Math.max(...flat.map(p=>p[0]))-Math.min(...flat.map(p=>p[0])), "
                  "bh:Math.max(...flat.map(p=>p[1]))-Math.min(...flat.map(p=>p[1]))};}",TESTSVG)
    print("  strokes",r["n"],"points",r["pts"],"finite",r["fin"],
          "bbox",round(r["bw"],2),"x",round(r["bh"],2))
    print("  SVG", "OK" if r["n"]>=4 and r["fin"] and r["bw"]>0.5 and r["bh"]>0.3 else "FAIL")

    print("== image raster ==")
    r=pg.evaluate("""()=>{
      const cv=document.createElement('canvas'); cv.width=80; cv.height=60;
      const cx=cv.getContext('2d');
      cx.fillStyle='#fff'; cx.fillRect(0,0,80,60);
      cx.fillStyle='#000'; cx.fillRect(0,0,40,60);
      setImageCanvas(cv);
      document.getElementById('srcKind').value='image';
      document.getElementById('srcKind').dispatchEvent(new Event('change'));
      const st=imageStrokes();
      const xs=st.flat().map(p=>p[0]);
      const rowsY=[...new Set(st.map(s=>s[0][1].toFixed(2)))];
      const dirs=st.map(s=>Math.sign(s[1][0]-s[0][0]));
      let alt=true; for(let i=1;i<dirs.length;i++) if(dirs[i]===dirs[i-1]) alt=false;
      return {n:st.length, maxX:Math.max(...xs), rows:rowsY.length, serp:alt, noRe:S.noReorder};}""")
    print("  dashes",r["n"],"rows",r["rows"],"serpentine",r["serp"],
          "maxX",round(r["maxX"],1),"(dark is left so should be <= ~1)","noReorder",r["noRe"])
    print("  IMAGE","OK" if r["n"]>10 and r["serp"] and r["maxX"]<2 and r["noRe"] else "FAIL")

    print("== sketch capture via pointer events ==")
    pg.select_option("#srcKind","sketch"); pg.wait_for_timeout(250)
    box=pg.eval_on_selector("#target","e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height]}")
    cx0,cy0=box[0]+box[2]/2, box[1]+box[3]/2
    pg.mouse.move(cx0-80,cy0-40); pg.mouse.down()
    for i in range(12): pg.mouse.move(cx0-80+i*14, cy0-40+i*7)
    pg.mouse.up(); pg.wait_for_timeout(250)
    r=pg.evaluate("()=>({n:S.sketch.length, pts:S.sketch[0]?S.sketch[0].length:0, label:document.getElementById('vSketchN').textContent})")
    print("  strokes",r["n"],"points",r["pts"],"counter",r["label"])
    q=pg.evaluate("()=>({cmds:S.cmds.length})")
    print("  planned cmds from sketch:",q["cmds"])
    print("  SKETCH","OK" if r["n"]==1 and r["pts"]>5 and q["cmds"]>10 else "FAIL")

    print("== clip banner ==")
    pg.select_option("#srcKind","text"); pg.fill("#txt","DETENT")
    pg.fill("#limMinY","-3"); pg.fill("#limMaxY","3"); pg.check("#limOn")
    pg.wait_for_timeout(400)
    vis=pg.eval_on_selector("#clipWarn","e=>getComputedStyle(e).display")
    print("  banner display:",vis,"| BANNER","OK" if vis=="block" else "FAIL")

    pg.screenshot(path="audit_shot.png",full_page=False)
    b.close()
print("page errors:",errs or "none")

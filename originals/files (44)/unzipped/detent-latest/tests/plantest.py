from playwright.sync_api import sync_playwright
import pathlib
url="file://"+str(pathlib.Path("/home/claude/detent/detent-plot.html").resolve())
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1560,"height":980})
    errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.goto(url); pg.wait_for_timeout(900)
    pg.evaluate("document.querySelectorAll('.grp').forEach(g=>g.classList.remove('collapsed'))")

    print("== planner profile on the square pattern ==")
    r=pg.evaluate("""()=>{
      document.querySelectorAll('[data-cal]').forEach(b=>{if(b.dataset.cal==='square')b.click();});
      return null;}""")
    pg.wait_for_timeout(400)
    r=pg.evaluate("""()=>{
      const c=S.cmds.filter(c=>c.iv);
      if(!c.length) return {fail:'no ivs'};
      const ivs=c.map(x=>x.iv);
      // find a corner: direction change with cos below 0.3 (90 deg turn)
      let corner=-1;
      for(let i=2;i<c.length-2;i++){
        const ax=c[i].x-c[i-1].x, ay=c[i].y-c[i-1].y;
        const bx=c[i+1].x-c[i].x, by=c[i+1].y-c[i].y;
        const ma=Math.hypot(ax,ay), mb=Math.hypot(bx,by);
        if(ma<0.5||mb<0.5) continue;
        if((ax*bx+ay*by)/(ma*mb) < 0.3){corner=i;break;}
      }
      const mid=Math.floor(c.length/2);
      return {n:c.length, ivStart:ivs[1], ivCruise:Math.min(...ivs),
              ivCorner:corner>0?ivs[corner]:null, corner,
              startSlow:ivs[1]>Math.min(...ivs)*1.5,
              cornerSlow:corner>0&&ivs[corner]>Math.min(...ivs)*1.5};}""")
    print("  pts",r.get("n"),"iv start",r.get("ivStart"),"cruise",r.get("ivCruise"),
          "at corner",r.get("ivCorner"))
    print("  ramps from standstill:",r.get("startSlow"),"| slows into corner:",r.get("cornerSlow"))
    print("  PLANNER","OK" if r.get("startSlow") and r.get("cornerSlow") else "FAIL")

    print("== batch line carries iv ==")
    pg.evaluate("()=>{S.plotting=true; return streamCmds(S.cmds.slice(0,7));}")
    pg.wait_for_timeout(300)
    line=pg.eval_on_selector("#log","e=>{const t=[...e.children].map(c=>c.textContent);return t.reverse().find(x=>x.includes('> S '))||''}")
    import re
    tok=line.split()[2] if len(line.split())>2 else ""
    print("  sample token:",tok,"| four fields:", tok.count(",")==3)

    print("== planner off strips iv ==")
    pg.evaluate("()=>{S.plotting=false;}")
    pg.uncheck("#oPlan"); pg.wait_for_timeout(300)
    n=pg.evaluate("()=>S.cmds.filter(c=>c.iv).length")
    print("  cmds with iv after off:",n,"| OK" if n==0 else "| FAIL")
    pg.check("#oPlan")

    print("== est runtime uses profile ==")
    t=pg.eval_on_selector("#vTime","e=>e.textContent")
    print("  est:",t)

    print("== stall hunt runs offline without exceptions ==")
    pg.evaluate("()=>{ stallHunt(); }")
    pg.wait_for_timeout(2500)
    pg.evaluate("()=>{S.plotting=false;}")  # stop it early
    logtxt=pg.eval_on_selector("#log","e=>e.textContent")
    print("  hunt logged:", "STALL HUNT" in logtxt and "X at 500" in logtxt)

    b.close()
print("page errors:",errs or "none")

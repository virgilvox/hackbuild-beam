from playwright.sync_api import sync_playwright
import pathlib
url="file://"+str(pathlib.Path("detent-plot.html").resolve())
with sync_playwright() as p:
    b=p.chromium.launch()
    for w,h,name in [(1100,900,"narrow"),(1920,1080,"wide"),(1400,820,"laptop")]:
        pg=b.new_page(viewport={"width":w,"height":h})
        errs=[];pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.goto(url);pg.wait_for_timeout(900)
        hs=pg.evaluate("()=>document.body.scrollWidth>window.innerWidth+1")
        clip=pg.evaluate("""()=>{const o=[];document.querySelectorAll('button,.chip,h3,.kv').forEach(e=>{if(e.scrollWidth>e.clientWidth+2)o.push(e.id||e.textContent.trim().slice(0,20))});return o}""")
        hdr=pg.eval_on_selector("header","e=>Math.round(e.getBoundingClientRect().height)")
        print(name.ljust(7),w,"x",h,"| h-scroll",hs,"| header h",hdr,"| clipped",clip or "none","| errors",errs or "none")
        pg.close()
    b.close()

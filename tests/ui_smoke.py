"""Browser smoke test (Chromium via Playwright). Serves the site statically; /api/chat is mocked.
Run from the project root:  python3 tests/ui_smoke.py   (needs: pip install playwright && playwright install chromium)"""
import json, subprocess, time, sys, os, signal
from playwright.sync_api import sync_playwright
PORT=8123; BASE="http://localhost:%d/index.html"%PORT
reqs=[]; errors=[]; mode={"v":"normal"}
SRC=[{"n":1,"id":"LFHS-218","page":10,"chapter":"Genetics of Life","kind":"passage","cited":True}]
def api(route):
    body=json.loads(route.request.post_data or "{}"); reqs.append(body); ctx=body.get("ctx") or {}; a=ctx.get("action")
    if mode["v"]=="noev" and a!="chat": r={"reply":"I couldn't find enough about this topic in your Class %s materials. Try a broader topic or a chapter name."%ctx.get("cls"),"noEvidence":True,"sources":[],"items":[]}
    elif a=="quiz": r={"items":[{"q":"Which molecule carries genes?","options":["DNA","RNA","ATP","Lipid"],"answer":0,"explain":"DNA stores genetic information.","src":[1]},{"q":"Who proposed the double helix?","options":["Watson and Crick","Mendel","Darwin","Pasteur"],"answer":0,"explain":"","src":[1]}],"sources":SRC,"requested":5,"returned":2,"shortfall":True,"grounded":True,"provider":"groq"}
    elif a=="flashcards": r={"items":[{"q":"What is a gene?","a":"A section of DNA that carries hereditary information.","src":[1]}],"sources":SRC,"requested":5,"returned":1,"shortfall":True,"grounded":True,"provider":"groq"}
    elif a=="revision": r={"reply":"**Revision**\n- DNA carries genes [1]","sources":SRC,"grounded":True,"provider":"groq"}
    elif mode["v"]=="general": r={"reply":"Black holes are regions of space where gravity is extremely strong.","provider":"groq","grounded":False,"supplementary":True,"sources":[]}
    else: r={"reply":"DNA fingerprinting compares DNA patterns [1].","provider":"groq","grounded":True,"supplementary":False,"sources":SRC,"unverified":False}
    route.fulfill(status=200,content_type="application/json",body=json.dumps(r))
def go(pg,hash_):
    pg.goto(BASE+hash_); pg.wait_for_timeout(500)
    pg.evaluate('typeof dismissIntro==="function"&&dismissIntro()'); pg.wait_for_timeout(1000)
def run(p,label,vp,cls):
    b=p.chromium.launch(); c=b.new_context(viewport=vp,is_mobile=vp["width"]<500,has_touch=vp["width"]<500)
    c.add_init_script("localStorage.setItem('lfhs.class',JSON.stringify('%s'))"%cls)
    pg=c.new_page(); pg.on("pageerror",lambda e:errors.append(label+": "+str(e)))
    pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith("http://localhost") else r.abort()); pg.route("**/api/chat*",api)
    go(pg,"#ai"); R={}
    R["removed_controls_absent"]=pg.evaluate("['aiSubj','aiCtxClass','aiCtx','aiActions'].every(i=>!document.getElementById(i))&&!document.querySelector('[data-aimode]')")
    R["input_width_px"]=round(pg.evaluate("document.getElementById('userInput').getBoundingClientRect().width"))
    R["messages_height_px"]=round(pg.evaluate("document.getElementById('chatMessages').getBoundingClientRect().height"))
    R["visible_footer_controls"]=pg.evaluate("[...document.querySelectorAll('.chat-container .chat-input-area button, .chat-container .chat-input-area select, .chat-container .chat-input-area input')].filter(e=>e.offsetParent).length")
    R["suggestions"]=pg.eval_on_selector_all("#chatQuick .qchip","e=>e.map(x=>x.textContent)")
    pg.fill("#userInput","What is DNA fingerprinting?"); pg.click("#sendBtn"); pg.wait_for_selector("details.ai-src",timeout=5000)
    R["sent_ctx"]=reqs[-1]["ctx"]; R["grounded_has_no_label"]=pg.locator(".ai-badge").count()==0; R["cite_markers"]=pg.locator("sup.cite").count()
    pg.evaluate("window.__o=null;window.openPdfViewer=function(i,p){window.__o=[i,p]}"); pg.click("details.ai-src summary"); pg.click(".ai-srclink"); R["source_opens_at"]=pg.evaluate("window.__o")
    pg.click("[data-aisave]"); R["saved"]=pg.evaluate("JSON.parse(localStorage.getItem('lfhs.aiSaved')||'[]').length")
    pg.click("[data-aifollow=chat]"); pg.wait_for_timeout(500); R["followup_sent"]=reqs[-1]["messages"][-1]["text"]
    mode["v"]="general"; pg.fill("#userInput","Tell me about black holes"); pg.click("#sendBtn"); pg.wait_for_selector(".ai-badge.gen",timeout=5000); R["general_badge"]=pg.inner_text(".ai-badge.gen")[:70]; mode["v"]="normal"
    pg.click("#aiToolsBtn"); R["tools_open"]=pg.is_visible("#aiTools"); R["voice_lang_in_menu"]=pg.is_visible("#voiceLang"); pg.screenshot(path="/tmp/shot_%s_tools.png"%label)
    pg.click("[data-aiact=revision]"); R["revision_without_topic_blocked"]=(reqs[-1]["ctx"].get("action")!="revision"); R["menu_closed_after_pick"]=not pg.is_visible("#aiTools")
    pg.fill("#userInput","Genetics of life"); pg.click("#aiToolsBtn"); pg.click("[data-aiact=revision]"); pg.wait_for_timeout(600); R["revision_ctx"]={k:reqs[-1]["ctx"].get(k) for k in("cls","action","topic")}
    R["overflow_x"]=pg.evaluate("document.documentElement.scrollWidth>window.innerWidth+1"); pg.screenshot(path="/tmp/shot_%s_ai.png"%label)
    go(pg,"#quiz"); pg.wait_for_selector("#quizTopic",state="visible",timeout=5000); pg.fill("#quizTopic","Genetics DNA"); pg.click("#quizStart"); pg.wait_for_timeout(1200)
    R["quiz_ctx"]={k:reqs[-1]["ctx"].get(k) for k in("cls","action","count","topic")}; R["quiz_cards"]=pg.locator(".qz-card").count()
    pg.locator(".qz-card button").first.click(); pg.wait_for_timeout(300); R["quiz_shows_source"]=("Source: " in pg.inner_text("#quizOut"))
    mode["v"]="noev"; pg.click("#quizStart"); pg.wait_for_timeout(900); R["quiz_no_material_msg"]=("couldn't find enough" in pg.inner_text("#quizOut")); R["no_general_fallback_button"]=pg.locator("[data-qzgeneral]").count()==0; mode["v"]="normal"
    pg.click("#quizModeCards"); pg.fill("#quizTopic","Genetics DNA"); pg.click("#quizStart"); pg.wait_for_timeout(1200)
    R["cards_ctx_action"]=reqs[-1]["ctx"].get("action"); R["cards_text_has_source"]=("LFHS-218" in pg.inner_text("#flashcardWrap")) or ("Biology" in pg.inner_text("#flashcardWrap")) or ("p.10" in pg.inner_text("#flashcardWrap"))
    pg.screenshot(path="/tmp/shot_%s_quiz.png"%label); b.close(); return R
srv=subprocess.Popen([sys.executable,"-m","http.server",str(PORT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1.5)
try:
    with sync_playwright() as p:
        for label,vp,cls in [("phone_390_c8",{"width":390,"height":844},"8"),("phone_412_c10",{"width":412,"height":915},"10"),("desktop_c10",{"width":1280,"height":800},"10")]:
            print("=====",label); print(json.dumps(run(p,label,vp,cls),indent=1,ensure_ascii=False))
finally: srv.send_signal(signal.SIGTERM)
print("PAGE ERRORS:",errors or "none")

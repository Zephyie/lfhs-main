"""Browser test (Chromium via Playwright) for: account stats, Settings (locked for class accounts), Class Account signup box,
creator panel layout, and the "general answer*" labels. /api/account, /api/content and /api/chat are mocked.
Run from the project root:  python3 tests/ui_account.py"""
import json, subprocess, sys, time, signal
from playwright.sync_api import sync_playwright
PORT=8125; BASE="http://localhost:%d/index.html"%PORT
log=[]; errors=[]
def seed(cls_acc, owner=False):
    sess={"token":"x"*40,"username":"owner" if owner else ("class10a" if cls_acc else "ayesha.k"),"role":"creator" if owner else "user","classAccount":cls_acc}
    data={"lfhs.class":"8","lfhs.tasks":[{"id":1,"title":"a","done":True},{"id":2,"title":"b","done":False},{"id":3,"title":"c","done":True}],
          "lfhs.progress":{"t1":"done","t2":"learning","t3":"done","t4":"todo"},"lfhs.saved":["LFHS-001","LFHS-002","LFHS-003"],
          "lfhs.flashcards":[{"id":"fc1","q":"q","a":"a","cls":"8","subj":"Maths","topic":"t","dueAt":1}],
          "lfhs.quizHistory":[{"score":3,"total":5,"cls":"8","subj":"Maths","topic":"x","at":1},{"score":4,"total":5,"cls":"8","subj":"Maths","topic":"y","at":2}],
          "lfhs.focusStats":{"minutes":135},"lfhs.session":sess}
    return ";".join("localStorage.setItem(%s,%s)"%(json.dumps(k),json.dumps(json.dumps(v))) for k,v in data.items())
MEMBERS=[{"username":"owner","role":"owner","isOwner":True,"created":"2026-01-02T00:00:00Z","classAccount":False},{"username":"ayesha.k","role":"user","isOwner":False,"created":"2026-03-04T00:00:00Z","classAccount":False},{"username":"class10a","role":"user","isOwner":False,"created":"2026-04-04T00:00:00Z","classAccount":True}]
CONTENT={"content":{"notices":[{"id":"n1","type":"general","aud":"all","title":"Unit test schedule","date":"2026-11-10","until":"","url":"","pin":True}],"countdown":[],"featured":[],"contacts":[],"updates":[]},"rev":1,"storage":True}
def make_handlers(state):
    def acct(route):
        b=json.loads(route.request.post_data or "{}"); a=b.get("action"); log.append(b); code=200
        if a=="me": r={"ok":True,"username":state["user"],"role":state["role"],"isOwner":state["role"]=="creator","classAccount":state["cls"]}
        elif a=="load": r={"ok":True,"data":{},"updatedAt":None}
        elif a=="verifyPassword": r,code=({"ok":True},200) if b.get("password")=="right-pass" else ({"error":"Wrong password."},403)
        elif a=="register": r,code={"error":"test: not creating a real account"},400
        elif a=="listMembers": r={"ok":True,"members":MEMBERS}
        elif a=="listPasswordResetRequests": r={"ok":True,"requests":[]}
        else: r={"ok":True}
        route.fulfill(status=code,content_type="application/json",body=json.dumps(r))
    def content(route):
        route.fulfill(status=200,content_type="application/json",body=json.dumps(CONTENT if route.request.method=="GET" else {"ok":True}))
    def chat(route):
        b=json.loads(route.request.post_data or "{}"); log.append(b); a=(b.get("ctx") or {}).get("action")
        src=[{"n":1,"id":"LFHS-218","page":10,"chapter":"Genetics of Life","kind":"passage"}]
        if a=="quiz": items=[{"q":"Textbook Q%d?"%i,"options":["a","b","c","d"],"answer":0,"explain":"","src":[1]} for i in range(3)]+[{"q":"Extra Q%d?"%i,"options":["a","b","c","d"],"answer":1,"explain":"","general":True} for i in range(2)]; r={"items":items,"sources":src,"requested":5,"returned":5,"groundedCount":3,"generalCount":2,"shortfall":False,"grounded":True,"provider":"groq"}
        elif a=="flashcards": items=[{"q":"Textbook card?","a":"A","src":[1]},{"q":"Extra card?","a":"B","general":True}]; r={"items":items,"sources":src,"requested":2,"returned":2,"groundedCount":1,"generalCount":1,"shortfall":False,"grounded":True,"provider":"groq"}
        else: r={"reply":"ok","provider":"groq","grounded":False,"sources":[]}
        route.fulfill(status=200,content_type="application/json",body=json.dumps(r))
    return acct,content,chat
def new_page(p,vp,init,state):
    b=p.chromium.launch(); c=b.new_context(viewport=vp,is_mobile=vp["width"]<500,has_touch=vp["width"]<500); c.add_init_script(init)
    pg=c.new_page(); pg.on("pageerror",lambda e:errors.append(str(e)))
    pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith("http://localhost") else r.abort())
    acct,content,chat=make_handlers(state); pg.route("**/api/account*",acct); pg.route("**/api/content*",content); pg.route("**/api/chat*",chat)
    return b,pg
def go(pg,h=""):
    pg.goto(BASE+h); pg.wait_for_timeout(700); pg.evaluate('typeof dismissIntro==="function"&&dismissIntro()'); pg.wait_for_timeout(900)
def modal_text(pg): return pg.inner_text(".acc-modal")
def run(p,label,vp):
    R={}
    # ---- A: normal account ----
    b,pg=new_page(p,vp,seed(False),{"user":"ayesha.k","role":"user","cls":False}); go(pg); pg.click("#accountBtn"); pg.wait_for_timeout(400); t=modal_text(pg)
    R["A_stats_shown"]=all(x in t for x in ["Class 8","2 / 3","2 / 4","3","1","70%","2 hr 15 min"]) and "Planner tasks done" in t
    R["A_menu_has_settings"]=pg.locator("[data-acc=settings]").count()==1 and not pg.locator("[data-acc=settings] .fa-lock").count()
    R["A_menu_hides_pw_and_logout"]=pg.locator("[data-acc=changepw]").count()==0 and pg.locator("[data-acc=logout]").count()==0
    pg.screenshot(path="/tmp/acc_%s_normal.png"%label)
    pg.click("[data-acc=settings]"); pg.wait_for_timeout(300)
    R["A_settings_opens_directly_with_pw_and_logout"]=pg.locator("[data-acc=changepw]").count()==1 and pg.locator("[data-acc=logout]").count()==1
    pg.click("[data-acc=back]"); pg.wait_for_timeout(200); R["A_back_returns_to_stats"]="Planner tasks done" in modal_text(pg); b.close()
    # ---- B: class account ----
    st={"user":"class10a","role":"user","cls":True}; b,pg=new_page(p,vp,seed(True),st); go(pg); pg.click("#accountBtn"); pg.wait_for_timeout(400); t=modal_text(pg)
    R["B_stats_shown"]="Planner tasks done" in t and "2 hr 15 min" in t and "Class account" in t
    R["B_no_pw_or_logout_in_menu"]=pg.locator("[data-acc=changepw]").count()==0 and pg.locator("[data-acc=logout]").count()==0 and pg.locator("input[type=password]").count()==0
    R["B_settings_has_lock_icon"]=pg.locator("[data-acc=settings] .fa-lock").count()==1
    pg.click("[data-acc=settings]"); pg.wait_for_timeout(300)
    R["B_settings_is_locked"]=pg.locator("#accUnlock").count()==1 and pg.locator("[data-acc=changepw]").count()==0 and pg.locator("[data-acc=logout]").count()==0
    pg.fill("#accUnlock","wrong-pass"); pg.click("[data-acc=unlock]"); pg.wait_for_timeout(500)
    R["B_wrong_password_stays_locked"]=("Wrong password" in modal_text(pg)) and pg.locator("[data-acc=changepw]").count()==0
    pg.fill("#accUnlock","right-pass"); pg.press("#accUnlock","Enter"); pg.wait_for_timeout(500)
    R["B_right_password_opens_settings"]=pg.locator("[data-acc=changepw]").count()==1 and pg.locator("[data-acc=logout]").count()==1
    pg.screenshot(path="/tmp/acc_%s_class_settings.png"%label)
    pg.click("[data-acc=back]"); pg.click("[data-acc=close]"); pg.wait_for_timeout(300); pg.click("#accountBtn"); pg.wait_for_timeout(300); pg.click("[data-acc=settings]"); pg.wait_for_timeout(300)
    R["B_locks_again_after_closing"]=pg.locator("#accUnlock").count()==1 and pg.locator("[data-acc=logout]").count()==0
    # session restored from storage keeps the class flag after a reload
    pg.reload(); pg.wait_for_timeout(900); pg.evaluate('typeof dismissIntro==="function"&&dismissIntro()'); pg.wait_for_timeout(800); pg.click("#accountBtn"); pg.wait_for_timeout(300)
    R["B_still_class_after_reload"]=pg.locator("[data-acc=settings] .fa-lock").count()==1 and pg.locator("[data-acc=logout]").count()==0; b.close()
    # ---- C: signup checkbox ----
    b,pg=new_page(p,vp,"",{"user":"x","role":"user","cls":False}); go(pg); pg.click("#accountBtn"); pg.wait_for_timeout(300); pg.click("[data-acc=tab][data-t=signup]"); pg.wait_for_timeout(300)
    R["C_checkbox_present_unticked"]=pg.locator("#accClass").count()==1 and not pg.is_checked("#accClass") and "Class Account" in modal_text(pg)
    pg.screenshot(path="/tmp/acc_%s_signup.png"%label)
    def signup(tick):
        pg.fill("#accUser","class9b"); pg.fill("#accPass","secret-123"); pg.fill("#accPass2","secret-123")
        if tick: pg.check("#accClass")
        else: pg.uncheck("#accClass")
        n=len(log); pg.click("[data-acc=signup]"); pg.wait_for_timeout(500); return [x for x in log[n:] if x.get("action")=="register"][-1]
    R["C_ticked_sends_true"]=signup(True).get("classAccount") is True; R["C_unticked_sends_false"]=signup(False).get("classAccount") is False; b.close()
    # ---- D: creator panel layout ----
    b,pg=new_page(p,vp,seed(False,owner=True),{"user":"owner","role":"creator","cls":False}); go(pg); pg.evaluate("openCreatorPanel()"); pg.wait_for_timeout(700)
    R["D_tabs_centered_equal"]=pg.evaluate("""()=>{const m=document.querySelector('.modal[aria-label="Creator panel"]'),bar=m.querySelector('.seg[aria-label="Creator tools"]'),t=[...bar.children].map(e=>e.getBoundingClientRect()),br=bar.getBoundingClientRect();
      const left=t[0].left-br.left,right=br.right-t[t.length-1].right;const widths=new Set(t.map(x=>Math.round(x.width)));return Math.abs(left-right)<=3&&widths.size===1}""")
    R["D_footer_buttons_equal_height"]=pg.evaluate("""()=>{const b=[...document.querySelectorAll('.modal[aria-label="Creator panel"] .cr-foot .btn')].map(e=>Math.round(e.getBoundingClientRect().height));return b.length>=2&&new Set(b).size===1}""")
    pg.screenshot(path="/tmp/cr_%s_notices.png"%label)
    pg.evaluate("CS.panel='members';creatorEditorView();loadMembers()"); pg.wait_for_timeout(700)
    R["D_members_marks_class_account"]="class account" in pg.inner_text(".modal[aria-label=\"Creator panel\"]")
    pg.screenshot(path="/tmp/cr_%s_members.png"%label); b.close()
    # ---- E: general-answer labels ----
    b,pg=new_page(p,vp,seed(False),{"user":"ayesha.k","role":"user","cls":False}); go(pg,"#quiz"); pg.wait_for_selector("#quizTopic",state="visible"); pg.fill("#quizTopic","Genetics"); pg.click("#quizStart"); pg.wait_for_timeout(1200)
    R["E_quiz_5_questions"]=pg.locator(".qz-card").count()==5; R["E_only_extra_ones_labelled"]=pg.locator(".qz-card .gen-tag").count()==2 and "general answer*" in pg.inner_text("#quizOut")
    R["E_quiz_footnote"]="General answer: not taken from your textbooks" in pg.inner_text("#quizOut"); pg.screenshot(path="/tmp/gen_%s_quiz.png"%label)
    pg.click("#quizModeCards"); pg.fill("#quizTopic","Genetics"); pg.click("#quizStart"); pg.wait_for_timeout(1200)
    R["E_cards_two"]=pg.evaluate("FLASHCARDS.length")==2; R["E_card_flags"]=pg.evaluate("FLASHCARDS.map(c=>!!c.gen)")==[False,True]
    pg.evaluate("FC.idx=1;FC.flipped=false;renderFlashcardUI()"); pg.wait_for_timeout(200); R["E_label_on_general_card"]=pg.locator(".flashcard-front .gen-tag").count()==1
    R["E_stored_marker"]=pg.evaluate("JSON.parse(localStorage.getItem('lfhs.flashcards')).filter(c=>c.gen===true).length")==1
    pg.evaluate("FC.idx=0;renderFlashcardUI()"); pg.wait_for_timeout(200); R["E_textbook_card_unlabelled"]=pg.locator(".flashcard-front .gen-tag").count()==0; b.close()
    return R
srv=subprocess.Popen([sys.executable,"-m","http.server",str(PORT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1.4)
bad=0
try:
    with sync_playwright() as p:
        for label,vp in [("phone",{"width":390,"height":844}),("desktop",{"width":1280,"height":900})]:
            R=run(p,label,vp); fails=[k for k,v in R.items() if v is not True]; bad+=len(fails)
            print("=====",label,"-",len(R)-len(fails),"/",len(R),"checks pass"); [print("  FAIL",k,R[k]) for k in fails]
finally: srv.send_signal(signal.SIGTERM)
print("PAGE ERRORS:",errors or "none"); sys.exit(1 if bad or errors else 0)

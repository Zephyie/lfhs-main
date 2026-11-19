"""Builds SYNTHETIC test PDFs (my own short sentences, NOT real SCERT text) to exercise the Malayalam / Hindi pipeline:
real Unicode text layers, a scanned (image-only) book, a legacy-font look-alike, a wrong-language book, and broken files.
Usage: python3 tests/make_lang_pdfs.py OUTDIR      Needs: reportlab, Pillow, FreeSerif font."""
import sys, os, glob
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
font = glob.glob('/usr/share/fonts/**/FreeSerif.ttf', recursive=True)[0]
pdfmetrics.registerFont(TTFont('FS', font))

ML = {  # (title, [paragraphs]) - synthetic
 1: ("മഴക്കാലം", ["കേരളത്തിൽ ജൂൺ മാസത്തിൽ കാലവർഷം ആരംഭിക്കുന്നു. ഇടവപ്പാതി എന്നും ഇതിനെ വിളിക്കുന്നു.", "മഴ പെയ്യുമ്പോൾ പുഴകൾ നിറഞ്ഞൊഴുകുന്നു. കർഷകർ വയലിൽ വിത്തുവിതയ്ക്കുന്നു.", "കുട്ടികൾ കുട ചൂടി സ്കൂളിലേക്ക് പോകുന്നു. മഴക്കാലത്ത് പനി വരാതെ ശ്രദ്ധിക്കണം."]),
 2: ("പുസ്തകവും വായനയും", ["വായന മനുഷ്യനെ വളർത്തുന്നു. പുസ്തകത്തിന്റെ താളുകൾ മറിക്കുമ്പോൾ പുതിയ ലോകം തുറക്കുന്നു.", "ഗ്രന്ഥശാലയിൽ നിന്ന് ഞങ്ങൾ പുസ്തകങ്ങൾ എടുക്കുന്നു. പുസ്തകം വായിച്ചാൽ അറിവ് കൂടുന്നു.", "ദിവസവും അല്പനേരം വായിക്കുന്ന ശീലം കുട്ടികൾക്ക് നല്ലതാണ്."]),
 3: ("പുഴയും ജീവിതവും", ["പുഴ നാടിന്റെ ജീവനാണ്. പെരിയാറും ഭാരതപ്പുഴയും കേരളത്തിലെ പ്രധാന നദികളാണ്.", "പുഴയിലെ വെള്ളം കുടിക്കാനും കൃഷിക്കും ഉപയോഗിക്കുന്നു. പുഴ മലിനമാക്കരുത്.", "മണൽ വാരുന്നത് പുഴയുടെ ഒഴുക്കിനെ ബാധിക്കുന്നു."]),
}
HI = {
 1: ("वर्षा ऋतु", ["भारत में वर्षा ऋतु जून के महीने में शुरू होती है। बादल घिर आते हैं और बारिश होती है।", "किसान खेतों में बीज बोते हैं। बच्चे छाता लेकर विद्यालय जाते हैं।", "बरसात में बीमारियों से बचने के लिए उबला हुआ पानी पीना चाहिए।"]),
 2: ("विद्यालय और पुस्तकें", ["विद्यालय ज्ञान का मंदिर है। हम पुस्तकालय से पुस्तकें लेते हैं।", "पुस्तकों को पढ़ने से ज्ञान बढ़ता है। शिक्षक हमें अच्छी बातें सिखाते हैं।", "रोज़ थोड़ी देर पढ़ने की आदत बच्चों के लिए अच्छी होती है।"]),
 3: ("नदी और जीवन", ["नदी हमारे जीवन का आधार है। गंगा और यमुना भारत की प्रमुख नदियाँ हैं।", "नदी का पानी पीने और खेती के काम आता है। हमें नदियों को स्वच्छ रखना चाहिए।", "रेत निकालने से नदी का बहाव प्रभावित होता है।"]),
}
def textbook(path, chapters, word):
    c = canvas.Canvas(path); W, H = 595, 842
    def page_no(n): c.setFont('FS', 10); c.drawString(W / 2, 30, str(n))
    c.setFont('FS', 20); c.drawString(60, 700, word + " - synthetic test textbook"); c.showPage()                       # p1 cover (short)
    c.setFont('FS', 16); c.drawString(60, 780, {"ml": "ഉള്ളടക്കം", "hi": "अनुक्रम"}[word if word in ("ml", "hi") else "ml"]) if False else None
    c.setFont('FS', 16); c.drawString(60, 780, "ഉള്ളടക്കം / अनुक्रम"); c.setFont('FS', 13)                                 # p2 contents
    start = 3; y = 740; starts = {}
    for n, (title, paras) in chapters.items():
        starts[n] = start; c.drawString(60, y, f"{n}    {title}    {start}"); y -= 26; start += 3
    page_no(2); c.showPage()
    for n, (title, paras) in chapters.items():
        for k in range(3):                                                                                        # 3 pages per chapter
            c.setFont('FS', 18); c.drawString(60, 780, title) if k == 0 else None
            c.setFont('FS', 13); y = 730
            for rep in range(3):
                for para in paras:
                    c.drawString(60, y, para); y -= 22
                y -= 10
            page_no(starts[n] + k); c.showPage()
    c.save()
textbook(f"{out}/ml_textbook.pdf", ML, "ml")
textbook(f"{out}/hi_textbook.pdf", HI, "hi")
# a second Malayalam book for class 8 (class-isolation tests)
textbook(f"{out}/ml_class8.pdf", {1: ("ഓണം", ["ഓണം കേരളത്തിന്റെ ദേശീയ ഉത്സവമാണ്. അത്തപ്പൂക്കളം ഒരുക്കുന്നു. ഓണസദ്യ ഇലയിൽ വിളമ്പുന്നു.", "മാവേലി മന്നൻ പ്രജകളെ കാണാൻ വരുന്നു എന്നാണ് വിശ്വാസം."]), 2: ("വള്ളംകളി", ["ആറന്മുള വള്ളംകളി പ്രസിദ്ധമാണ്. ചുണ്ടൻ വള്ളങ്ങൾ മത്സരിക്കുന്നു."])}, "ml")

# legacy-font look-alike: Latin-1 symbol soup (what old non-Unicode Malayalam fonts produce when extracted)
c = canvas.Canvas(f"{out}/legacy_font.pdf"); c.setFont('Helvetica', 12)
soup = "þÌdzÀ§Ã¡ ÈØÄ¢ÂÀ¢ ÊÃÂ¡ÈÖ ¢Ì¢ºÀÂ Ðp¦ÀÃ zÁÃ¢ÈÀ¡ ¸Â¿Ã¢Ø â¢ÀË ÂÃ¢Ä¢Ã"
for page in range(40):
    y = 780
    for i in range(30): c.drawString(50, y, soup + f" {page}{i}"); y -= 20
    c.showPage()
c.save()
# scanned books (image only, no text layer)
def image_pdf(path, lines, fontsize, pages=4):
    f = ImageFont.truetype(font, fontsize); c = canvas.Canvas(path)
    for p in range(pages):
        im = Image.new("L", (1240, 1754), 255); d = ImageDraw.Draw(im); y = 150
        for ln in lines: d.text((100, y), ln, font=f, fill=0); y += fontsize + 24
        tmp = f"{path}.{p}.png"; im.save(tmp); c.drawImage(tmp, 0, 0, 595, 842); c.showPage(); os.remove(tmp)
    c.save()
image_pdf(f"{out}/scanned_ml.pdf", ["കേരളത്തിൽ ജൂൺ മാസത്തിൽ കാലവർഷം ആരംഭിക്കുന്നു.", "മഴ പെയ്യുമ്പോൾ പുഴകൾ നിറഞ്ഞൊഴുകുന്നു.", "കർഷകർ വയലിൽ വിത്തുവിതയ്ക്കുന്നു."] * 3, 34)
image_pdf(f"{out}/scanned_en.pdf", ["The monsoon begins in Kerala in the month of June.", "Rivers overflow when the rain falls heavily.", "Farmers sow seeds in the wet fields of the village.", "Photosynthesis is the process by which green plants make food."] * 3, 40)
# English text labelled as Malayalam in the catalogue (wrong medium)
c = canvas.Canvas(f"{out}/english_as_malayalam.pdf"); c.setFont('FS', 13)
for page in range(5):
    y = 780
    for i in range(16): c.drawString(50, y, "The quick lesson explains how plants grow in the school garden every year."); y -= 22
    c.showPage()
c.save()
# broken files
open(f"{out}/not_a_pdf.pdf", "w").write("<html><body>Access denied</body></html>" * 200)
data = open(f"{out}/ml_textbook.pdf", "rb").read(); open(f"{out}/truncated.pdf", "wb").write(data[:max(6000, len(data) // 5)])
open(f"{out}/tiny.pdf", "wb").write(b"%PDF-1.4\n%%EOF\n")
print("built", len(os.listdir(out)), "files in", out)

# LFHS Academic Hub v22 - resource-first AI (GitHub-hosted library)

## How it works
1. `scripts/ingest.mjs` reads `data/pdfs.js`, downloads each PDF, extracts the text page by page, splits it into passages and writes
   one file per class + subject into **`api/_kb/`** (for example `10-biology.json`). These files are committed to the repo.
2. Vercel bundles `api/_kb/**` with the AI function (`vercel.json` -> `includeFiles`). Nothing is downloaded or extracted when a student asks.
3. When a student asks a question, `api/chat.js` receives the dashboard class (invisible in the UI), searches that class's passages
   (BM25 keyword ranking, in memory), and works out the subject from the best matches or from words like "physics".
4. If the passages really contain the question's key words, the AI is given them and must cite them as [1], [2]. The app shows the
   resource, page and a button that opens the PDF at that page.
5. If nothing matches, the AI answers normally. For a school-subject question it is told to mark the answer as general, and the app
   shows "General answer, not from your textbooks". Chit-chat, study planning and career questions get no label.
6. Quizzes, flashcards, revision sheets and past questions are library-only: if the library does not support them they say so
   (and return fewer items rather than inventing any). Scoring stays in browser code.

## Files
| File | What |
|---|---|
| `api/chat.js` | AI backend (modified). Same URL and env var names. `GET /api/chat?status=1` reports what is configured and what the library holds. |
| `api/_kb.js` | Search, evidence check, citation check, caching, circuit breaker (new; the underscore keeps Vercel from treating it as a function) |
| `api/_kb/*.json` | The library (generated). Ships with a 3-PDF sample until you run the full build. |
| `scripts/ingest.mjs` | Builds the library from the PDFs |
| `scripts/verify.mjs` | Deploy-readiness check |
| `.github/workflows/build-library.yml` | Builds the whole library in the cloud (no computer needed) |
| `index.html`, `sw.js` | AI tab simplified; sources open the PDF at the page; quizzes/flashcards call the library; service-worker cache bumped to v27 |
| `tests/` | Search, API and browser tests |

Unchanged: `api/account.js`, `api/content.js`, `data/pdfs.js`, login, planner, saved resources, Creator Panel, resource IDs and URLs.
New local-only keys: `lfhs.aiSaved` (saved answers).

## Costs and limits
- Library size: about 0.9 KB of text per PDF page, so roughly 8-10 MB for all 9,100 pages. The Vercel function limit is 250 MB.
- A class library (about 3-6 MB) loads in about 0.5 s on a cold start and answers a search in a few milliseconds.
- AI use: one call per question at most (none for past questions, none when a quiz/flashcard request is unsupported); at most 4 upstream calls per request; providers that fail 3 times pause for 60 s; generated quizzes/flashcards/revision sheets are cached in memory (and in Supabase if you keep those variables set).
- Supabase is **no longer needed for the AI library**. Login/sync still use it.

## Known limitations
- Keyword search, not meaning-based: a question that shares no words with the textbook can miss. (Stemming helps: "electricity" finds "electric".)
- Scanned PDFs without a text layer are skipped and listed in the build log.
- Chapter detection: textbook Contents page, "Chapter N" headings in question banks, "Ch. N" in note titles.
- `data/pdfs.js` currently lists lfhs-1, lfhs-2 and lfhs-3 only. Add the lfhs-4 PDFs to the catalog and re-run the build to include them.
- Generated-answer cache is per server instance unless Supabase variables are set.


---

# v24: Malayalam and Hindi support (multilingual Knowledge Engine)

The engine now indexes, searches and answers from **English, Malayalam and Hindi** textbooks. The architecture is unchanged: one catalog
(`data/pdfs.js`), one ingest script, one set of shard files in `api/_kb/`, one retrieval engine. Existing English data and resource IDs are untouched.

## What changed
| Area | Before | Now |
|---|---|---|
| Tokenizing | `[a-z0-9]` only, so every Malayalam/Hindi word vanished | Unicode letters + combining marks of any script (`\p{L}\p{M}\p{N}`) |
| Normalizing | none | NFC; old-style Malayalam chillu (consonant + virama + ZWJ) becomes the atomic chillu letter; zero-width characters removed. Queries and stored text are normalized the same way |
| Matching inflected words | English stemmer only | English stemmer; Malayalam/Hindi words also index a prefix key (5 code points Malayalam, 4 Devanagari) so പുസ്തകങ്ങൾ finds പുസ്തകത്തിന്റെ and नदियों finds नदियाँ |
| Stop words | English | English + short Hindi and Malayalam function-word lists (never content words) |
| Medium | not modelled | every catalog entry has `medium` (English / Malayalam / Hindi); stored per book in the shard; each passage knows its language |
| Retrieval | one pool | a Malayalam or Hindi question searches that medium first; only if that has no evidence does it widen to everything, and every source names its medium. English questions behave exactly as before |
| Subject detection | English names | also "Malayalam", "Hindi", "Padavali", മലയാളം, पाठാവലി, हिंदी ... |
| De-duplication of quiz/flashcard items and cache keys | `[^a-z0-9 ]` (collapsed every non-English question to an empty string) | `[^\p{L}\p{M}\p{N} ]` |
| Page-quality check at ingest | English "wordiness" test (would reject every Malayalam page) | language-aware: script ratio, private-use (legacy-font) and replacement characters |
| Scanned / legacy-font pages | skipped | OCR with tesseract (eng, mal, hin) when installed; otherwise the book **fails loudly** and says what to install |
| AI prompts | English | keep Malayalam/Hindi in the original script, never transliterate or translate quotations; excerpts are labelled "malayalam textbook" / "hindi textbook"; general top-up questions for these subjects are written in that language and labelled "general answer*" |
| Source labels in the app | title and page | also the textbook language |
| Symbol-font glyphs in English books | stored as private-use characters | arrows, signs and bullets are mapped to the real character (mRNA → DNA) |

## Medium-aware behaviour (what a student sees)
- The student's **class** still comes from the dashboard. The **medium** is taken from the question: native-script questions search the matching textbook language first; English questions search the English books. Naming a language ("in the Hindi textbook ...") selects that subject.
- If the chosen medium has no evidence the assistant may use another medium, but the source line shows which textbook and language it came from.
- Textbook-grounded answers cite real passages. If nothing supports an answer it is labelled "General answer, not from your textbooks" (never presented as a textbook answer).
- Quizzes and flashcards for Malayalam/Hindi use the same rule as other subjects: textbook-based items first, then clearly labelled general items up to the number requested.

## Ingestion pipeline (repeatable and safe to re-run)
1. Add the book to `data/pdfs.js` (or use `scripts/acquire.mjs --add-to-catalog`). Required: `id` (unique), `cls` (8, 9, 10 or 8-9), `subj` (lowercase key, e.g. `malayalam`, `hindi`), `medium`, `url` (or `file` with `--local`), `title`.
2. `node scripts/ingest.mjs --medium Malayalam` (or `--cls 9`, `--ids ...`). Per book: download (3 tries) -> check it is a real PDF (header, size, readable page count) -> extract text per page -> language-aware quality check -> OCR where needed -> NFC + cleanup -> chapter detection -> passages -> shard.
3. Failures are reported and the book is **not** stored as an empty success: invalid catalog entry, duplicate id, bad/failed download, not a PDF, corrupt PDF, wrong medium (English text in a "Malayalam" book), unreadable legacy-font text, scanned book without OCR data. `api/_kb/ingest-report.json` lists them; `--strict` makes any failure exit non-zero.
4. Finished books are skipped on the next run (size match), existing shards are never deleted, and `--force` rebuilds a book with identical output.
5. `node scripts/verify.mjs` checks shard format, NFC, junk characters, per-book script ratio, page numbers against the catalog, and that no secrets are present.
6. Commit `api/_kb/` (the "Build AI library" workflow does this) and Vercel redeploys.

OCR needs tesseract with language data: `apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-mal tesseract-ocr-hin` (the workflow installs them). On Termux: `pkg install tesseract` and add the `mal` and `hin` traineddata files.

## Adding a future Malayalam, Hindi or other-language book
Add it to `data/acquisition.json` (or straight to the catalog), run the acquisition and ingest steps above. For a **new language** (for example Tamil): add it to `MEDIA`/`langOf`/`OCR_LANGS` in `scripts/ingest.mjs`, the script ranges and stop words in `api/_kb.js`, and the `subjectKey`/`inferSubject` words; the rest is generic.

## Known limitations
- **Cross-script search.** An English question does not retrieve Malayalam/Hindi passages (no translation or transliteration step); native-script queries work. Transliterated queries (for example "pustakam") are not matched.
- **Prefix matching is a heuristic**, not a morphological analyser: it joins common inflections but can also join unrelated words that share a prefix; ranking keeps exact matches first.
- **Chapter detection** for Indian-language books reads the contents page (two layouts supported); if it cannot, passages are still indexed with page numbers but without chapter titles.
- **OCR quality** for Malayalam is lower than for typed text; OCR'd pages are counted in the ingest report and should be spot-checked against the PDF.
- **Cold start** of a function that has to load a class's library is roughly 0.5-1 s per 6 MB of text; Malayalam/Hindi add a few MB.

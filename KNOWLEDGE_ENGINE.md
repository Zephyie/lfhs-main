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

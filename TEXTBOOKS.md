# Malayalam and Hindi textbook acquisition (Classes 8-10)

**Status: Completed.** All 10 official SCERT Kerala Malayalam and Hindi textbooks for Classes 8, 9, and 10 have been discovered from the official Samagra/KITE portal, verified, hosted in the `lfhs-4` GitHub Pages repository, cataloged in `data/pdfs.js` (LFHS-363 through LFHS-372), and ingested into the Knowledge Engine (`api/_kb/`).

## Acquisition Summary

- **Official Source**: KITE Samagra portal (`https://samagra.kite.kerala.gov.in/`)
- **Hosting Repository**: `https://github.com/Zephyie/lfhs-4` under `Textbooks/`
- **GitHub Pages Base URL**: `https://zephyie.github.io/lfhs-4/Textbooks/`
- **Total Volumes**: 10 textbooks (Classes 8, 9, 10; Malayalam AT & BT, Hindi)
- **Total Size**: 366 MB (all individual files <= 59 MB, well within GitHub's 100 MB limit)
- **Knowledge Engine**: 6 new/updated shards (`8-malayalam.json`, `8-hindi.json`, `9-malayalam.json`, `9-hindi.json`, `10-malayalam.json`, `10-hindi.json`) totalling 1,164 chunks.

## Verified Inventory & Catalog Mapping

| ID | Class | Subject | Medium | Book Series | Part | Edition | Source URL | File | Pages | Chunks | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LFHS-363 | 8 | Malayalam | Malayalam | Kerala Padavali (AT) | Part 1 | SCERT Revised (2025–26) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/mal/8/9/KeralaReaderMalayalamAT_1750263364833_282445335.pdf) | Class-8-Malayalam-Kerala-Padavali-Part-1.pdf | 88 | 168 | verified |
| LFHS-364 | 8 | Malayalam | Malayalam | Adisthana Padavali (BT) | Part 1 | SCERT Revised (2025–26) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/mal/8/17/KeralaReaderMalayalamBT_1750263396657_329504517.pdf) | Class-8-Malayalam-Adisthana-Padavali-Part-1.pdf | 48 | 103 | verified |
| LFHS-365 | 8 | Hindi | Hindi | Hindi | Part 1 | SCERT Revised (2025–26) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/mal/8/11/Kerala%20Reader%20Hindi_1750268605564_967830033.pdf) | Class-8-Hindi-Part-1.pdf | 96 | 115 | verified |
| LFHS-366 | 9 | Malayalam | Malayalam | Kerala Padavali (AT) | Part 1 | SCERT Revised (2024–25) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/Class%209/Malayalam_IX_AT_Vol_1/Malayalam_IX_AT_Vol_1.pdf) | Class-9-Malayalam-Kerala-Padavali-Part-1.pdf | 56 | 112 | legacy font (OCR mal+eng) |
| LFHS-367 | 9 | Malayalam | Malayalam | Kerala Padavali (AT) | Part 2 | SCERT Revised (2024–25) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/PARTII/01_Malayalam-9(AT)Part-2.pdf) | Class-9-Malayalam-Kerala-Padavali-Part-2.pdf | 40 | 68 | verified |
| LFHS-368 | 9 | Malayalam | Malayalam | Adisthana Padavali (BT) | Part 1 | SCERT Revised (2024–25) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/Class%209/Malayalam_IX_BT_Vol_1/Malayalam_IX_BT_Vol_1.pdf) | Class-9-Malayalam-Adisthana-Padavali-Part-1.pdf | 56 | 83 | legacy font (OCR mal+eng) |
| LFHS-369 | 9 | Hindi | Hindi | Hindi | Part 1 | SCERT Revised (2024–25) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/Class%209/HINDI_1/HINDI_1.pdf) | Class-9-Hindi-Part-1.pdf | 96 | 128 | legacy font (OCR hin+eng) |
| LFHS-370 | 10 | Malayalam | Malayalam | Kerala Padavali (AT) | Part 1 | SCERT Revised (2025–26) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/mal/10/9/Malayalam_1744350862081_862939213.pdf) | Class-10-Malayalam-Kerala-Padavali-Part-1.pdf | 96 | 150 | verified |
| LFHS-371 | 10 | Malayalam | Malayalam | Adisthana Padavali (BT) | Part 1 | SCERT Revised (2025–26) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/mal/10/17/Malayalam%20(BT)_1744351223833_978451345.pdf) | Class-10-Malayalam-Adisthana-Padavali-Part-1.pdf | 64 | 104 | verified |
| LFHS-372 | 10 | Hindi | Hindi | Hindi | Part 1 | SCERT Revised (2025–26) | [Samagra](https://samagra.kite.kerala.gov.in/files/samagra-resource/uploads2/tbookscmq/mal/10/11/Hindi_1744351435111_349086192.pdf) | Class-10-Hindi-Part-1.pdf | 104 | 133 | verified |

## Technical Implementation Highlights

1. **Text Normalization**: InDesign font export artifacts in SCERT PDFs (such as duplicate combining vowel signs `\u0d3e\u0d3e`, `\u0947\u0947` and embedded replacement marks before diacritics) are collapsed and normalized to standard NFC representations.
2. **Legacy Font Handling**: Volumes using legacy non-Unicode font mappings (Class 9 AT Part 1, BT Part 1, and Hindi Part 1) are automatically identified and OCR'd via Tesseract (`mal+eng` and `hin+eng`), yielding clean Malayalam and Hindi text layers.
3. **Multi-Part Volume Offsets**: Volumes with continuous page numbering (such as Class 9 AT Part 2, where printed pages continue from Part 1 at page 63) are correctly offset without erroneously classifying content pages as front matter.
4. **Library Totals**: The Knowledge Engine now contains 29 shard files, 373 indexed resources, and 17,304 searchable chunks (~8.9 MB uncompressed), fully compliant with Vercel serverless function size limits.

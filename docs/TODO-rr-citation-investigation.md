# TODO: Investigate Poe's False RR Citations

## Issue
In Poe's Response filed October 8, 2025, he wrote:

> "Prior to trial, both parties requested in their pretrials that a community property business, Anka Labs, be awarded to Husband. **(4 RR 29; 5 RR 1219)** Neither party changed their position on this issue. Per the parties' requests, the Court awarded Anka Labs to husband at a valuation of $1,500,000, and ordered him to pay Wife her community portion by awarding her a judgment to equalize of $750,000."

## Database Findings (2026-02-20)

**Only 3 Reporter's Record volumes exist in this case (03-25-00333-CV):**

| Volume | Filename | Pages | Status |
|--------|----------|-------|--------|
| 1 RR | TRAVIS-D-1-FM-25-000222-RR-VOL001.pdf | 8 | INDEXED |
| 2 RR | TRAVIS-D-1-FM-25-000222-RR-VOL002.pdf | 49 | INDEXED |
| 3 RR | TRAVIS-D-1-FM-25-000222-RR-VOL003.pdf | 154 | INDEXED |

**There is no "4 RR" or "5 RR".** The database contains zero documents matching VOL004, VOL005, VOL4, or VOL5.

Additionally, the two `D-1-FM-25-000222_Volume_1.pdf` and `D-1-FM-25-000222_Volume_2.pdf` files are NOT Reporter's Record volumes (likely Clerk's Record from lower court). They are in DISCOVERED status only, not indexed.

## Still TODO

- [ ] **Reindex RR volumes** with new layout-aware extraction to get proper line numbers (new code deployed 2026-02-20)
- [ ] Search for "Anka Labs" mentions across all indexed RR chunks to find what was actually said and on which pages
- [ ] Search for "pretrial" / "pre-trial" content to find what the parties actually requested
- [ ] Check page 29 across all 3 RR volumes to see what's there
- [ ] Note: page 1219 cannot exist — the largest RR volume (Vol 3) only has 154 pages
- [ ] Document the discrepancy formally: Poe cited non-existent volumes (4 RR, 5 RR) and an impossible page number (1219)

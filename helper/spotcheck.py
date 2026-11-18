"""Spot-check the AI scores against your own hand-scored books before a full run.

  uv run spotcheck.py <books.json> [--yes]

books.json: a list of {"title", "author", "totalPages", "difficulty"} (the old
bookapp's format). Prints the AI's components, content score, page difficulty and
reading-youth beside your figure, the correlation, and what it cost. Nothing is
saved into your library. Without --yes it only prints the cost estimate.
"""
import json
import statistics
import sys

import anthropic

import scoring

# page difficulty from the model's word estimate (same constants as the app)
V1, V10, EMIN, EMAX = 300, 75, 0.75, 6.0


def page_difficulty(words, pages, C):
    import math
    E = words / pages / (V1 * (V10 / V1) ** ((C - 1) / 9))
    return min(10, max(1, 1 + 9 * math.log(E / EMIN) / math.log(EMAX / EMIN)))


def main():
    path = sys.argv[1]
    books = json.load(open(path))
    est = scoring.estimate(len(books), [])
    print(f"{len(books)} books, about ${est['usd']:.3f} with {scoring.MODEL}.")
    if "--yes" not in sys.argv:
        print("Run again with --yes to spend it.")
        return
    client = anthropic.Anthropic()
    usage, rows = [], []
    for b in books:
        book = {"key": b["title"], "title": b["title"], "author": b.get("author"), "pages": b.get("totalPages")}
        try:
            s = scoring.score_book(client, book, usage)
        except scoring.ScoreProblem as ex:
            print(f"  {b['title']}: {ex}")
            continue
        D = page_difficulty(s["words"], b["totalPages"], s["C"]) if b.get("totalPages") else None
        rows.append((b["title"], b.get("difficulty"), s, D))
    print(f"\n{'Book':42} {'yours':>5} {'C':>4} {'D':>4} {'words':>7} {'youth':>5}  flags")
    for title, mine, s, D in rows:
        print(f"{title[:42]:42} {mine if mine is not None else '-':>5} {s['C']:>4} {D and round(D, 1) or '-':>4} {s['words']:>7} {s['youth']:>5}  {'; '.join(s['flags'])}")
    pairs = [(m, D) for _, m, _, D in rows if m is not None and D is not None]
    if len(pairs) >= 3:
        r = statistics.correlation([p[0] for p in pairs], [p[1] for p in pairs])
        diff = statistics.mean(p[1] - p[0] for p in pairs)
        print(f"\nCorrelation with your scores: {r:.2f}. AI page difficulty is on average {diff:+.1f} against yours.")
    yd = [(s["youth"], s["C"]) for _, _, s, _ in rows]
    if len(yd) >= 3:
        print(f"Youth vs content correlation: {statistics.correlation([a for a, _ in yd], [b for _, b in yd]):.2f} (above 0.8 would suggest the two are being conflated).")
    print(f"Cost: ${scoring.cost(usage):.4f} for {len(usage)} requests ({sum(u['in'] for u in usage)} tokens in, {sum(u['out'] for u in usage)} out).")
    json.dump([{"title": t, "yours": m, "score": s, "D": D} for t, m, s, D in rows], open("spotcheck-result.json", "w"), indent=1)


if __name__ == "__main__":
    main()

"""Reading-youth, re-scored for the whole library in one pass (prompt v3).

  uv run youth.py            # prints the books and the most it can cost
  uv run youth.py --yes      # spends it, writes youth-v<N>-candidate.json for review
  uv run youth.py --apply <candidate.json>   # writes a reviewed candidate into the catalogue

Youth v3 means "when is this book best read", not "when do people usually meet
it" (v2 asked that, which floated school set texts and childhood religious
reading to the top). Every book is placed on one scale beside all the others,
by a stronger model than the per-book difficulty scoring uses, so the order is
comparative rather than 180 separate guesses. Difficulty is not touched.

The helper keeps the catalogue in memory, so this stops it while writing and
starts it again afterwards.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time

import anthropic
import scoring
from pydantic import BaseModel, Field

MODEL = "claude-opus-5-5"
PROMPT_VERSION = 5
PRICE_IN, PRICE_OUT = 4 / 1e6, 20 / 1e6        # Claude Opus 5.5, per token
MAX_OUT = 48000                                 # also the cost ceiling: see main()
DATA = pathlib.Path.home() / "Library/Application Support/Antilibrary"

SYSTEM = """You're helping one reader put their whole library in order: the order in which to read these books across a life, from about seventeen onwards.

The question for each book is when in that life it is going to be good to read: when it will hit hardest, when the reader will be ready for it, and where it fits in a reading life that builds as it goes. Early books are ways in, and they give energy and appetite; later books ask more of the reader and pay back what came before. It is not a ranking of difficulty or of worth, and it is not about when schools set a book. The age of a book's narrator or subject doesn't decide it either way: a quiet book about patience or a long marriage can be good to read young; a book with a teenage narrator can need an adult reader.

{TASTE}

Work through the books one at a time, and for each one first write a short note on what it asks of the reader (background, earlier books, emotional weight, life experience it genuinely depends on) and what it gives at different points in a life. Then place it:
- stage, 1 to 5: 1 = opening out (late teens, first freedom); 2 = finding your feet (early twenties); 3 = taking on weight (later twenties); 4 = deepening (thirties); 5 = the long view (forty onwards).
- youth, 0 to 100: the same placing at finer grain (stage 1 is 0–20, 2 is 20–40, 3 is 40–60, 4 is 60–80, 5 is 80–100), so books within a stage are ordered too.
- after: numbers of other books in this list it is clearly best read after, usually none.
- any_time: true only for reference and picture books not meant to be read through. Every novel, poem, essay or argument gets a place.

Think about the list as a whole: compare books with each other, and make sure each stage holds the books that truly belong there. Cover every book exactly once, by its number."""
SYSTEM = SYSTEM.replace("{TASTE}", scoring.reading_taste())


class Placing(BaseModel):
    n: int = Field(description="The book's number in the list")
    note: str = Field(description="What it asks of the reader and what it gives, in one or two short clauses")
    stage: int = Field(description="1 to 5")
    youth: int = Field(description="0 to 100, inside the stage's band")
    after: list[int]
    any_time: bool


class Ordering(BaseModel):
    books: list[Placing]


def load():
    cat = json.loads((DATA / "catalogue.json").read_text())
    shelves = json.loads((DATA / "shelves.json").read_text())
    books = [b for b in shelves["books"] if cat["entries"].get("gr:" + b["goodreadsBookId"], {}).get("score")]
    return cat, books


def listing(books):
    def line(i, b):
        year = f", {b['year']}" if b.get("year") else ""
        return f"{i}. {b['title']} by {b.get('author') or 'unknown'}{year}"
    return "\n".join(line(i, b) for i, b in enumerate(books, 1))


def helper(cmd):
    subprocess.run([str(pathlib.Path.home() / ".local/bin/antilibrary-helper"), cmd], check=False, capture_output=True)


def apply(path):
    """Write a reviewed candidate file's youth placings into the catalogue."""
    cand = json.loads(pathlib.Path(path).read_text())
    helper("stop")
    time.sleep(1)
    cat = json.loads((DATA / "catalogue.json").read_text())
    n = 0
    for key, c in cand["books"].items():
        sc = cat["entries"].get(key, {}).get("score")
        if not sc:
            continue
        sc.setdefault("youth_v2", {"youth": sc.get("youth"), "reason": sc.get("youth_reason")})
        sc.update(youth=c["youth"], youth_reason=c["reason"], youth_stage=c.get("stage"), youth_any_time=c.get("any_time", False),
                  youth_after=c.get("after", []), youth_model=cand["model"], youth_prompt_version=cand["prompt_version"], youth_scored_at=cand["at"])
        n += 1
    (DATA / "catalogue.json").write_text(json.dumps(cat, ensure_ascii=False, indent=1))
    helper("start")
    print(f"Applied youth v{cand['prompt_version']} to {n} books.")


def main():
    if "--apply" in sys.argv:
        return apply(sys.argv[sys.argv.index("--apply") + 1])
    cat, books = load()
    client = anthropic.Anthropic()
    msg = "Books:\n" + listing(books)
    tin = client.messages.count_tokens(model=MODEL, system=SYSTEM, messages=[{"role": "user", "content": msg}]).input_tokens
    ceiling = tin * PRICE_IN + MAX_OUT * PRICE_OUT
    print(f"{len(books)} books, {tin} tokens in. {MODEL}: about ${tin * PRICE_IN + 12000 * PRICE_OUT:.2f}, at most ${ceiling:.2f}.")
    if "--yes" not in sys.argv:
        print("Run again with --yes to spend it.")
        return
    with client.messages.stream(
        model=MODEL, max_tokens=MAX_OUT, system=SYSTEM,
        output_config={"effort": "high"},
        messages=[{"role": "user", "content": msg}],
        output_format=Ordering,
    ) as stream:
        final = stream.get_final_message()
    u = final.usage
    spent = u.input_tokens * PRICE_IN + u.output_tokens * PRICE_OUT
    print(f"stop: {final.stop_reason}; {u.input_tokens} in, {u.output_tokens} out; ${spent:.3f}")
    out = final.parsed_output
    if final.stop_reason != "end_turn" or out is None:
        sys.exit("No usable answer; nothing written.")
    got = {p.n: p for p in out.books if 1 <= p.n <= len(books) and 0 <= p.youth <= 100}
    missing = [i for i in range(1, len(books) + 1) if i not in got]
    if len(missing) > len(books) // 20:
        sys.exit(f"{len(missing)} books missing from the answer; nothing written.")
    cand = {"model": MODEL, "prompt_version": PROMPT_VERSION, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "books": {"gr:" + books[i - 1]["goodreadsBookId"]: {"youth": p.youth, "stage": p.stage, "any_time": p.any_time, "reason": p.note,
                      "after": ["gr:" + books[j - 1]["goodreadsBookId"] for j in p.after if 1 <= j <= len(books) and j != i]}
                      for i, p in got.items()}}
    (DATA / f"youth-v{PROMPT_VERSION}-candidate.json").write_text(json.dumps(cand, ensure_ascii=False, indent=1))
    rows = list(got)
    extra = DATA / "usage-extra.json"          # other models' spending, priced at the time
    log = json.loads(extra.read_text()) if extra.exists() else []
    log.append({"in": u.input_tokens, "out": u.output_tokens, "at": time.time(), "job": "youth-v3", "model": MODEL, "usd": round(spent, 4)})
    extra.write_text(json.dumps(log, indent=1))
    print(f"Candidate written for {len(rows)} books (catalogue untouched)" + (f"; {len(missing)} missing kept their old score" if missing else "") + ".")


if __name__ == "__main__":
    main()

"""Reading-youth, re-scored for the whole library in one pass (prompt v3).

  uv run youth.py            # prints the books and the most it can cost
  uv run youth.py --yes      # spends it, writes youth into the catalogue

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
from pydantic import BaseModel, Field

MODEL = "claude-opus-5-5"
PROMPT_VERSION = 3
PRICE_IN, PRICE_OUT = 4 / 1e6, 20 / 1e6        # Claude Opus 5.5, per token
MAX_OUT = 32000                                 # also the cost ceiling: see main()
DATA = pathlib.Path.home() / "Library/Application Support/Antilibrary"

SYSTEM = """You order a personal library by reading-youth: for each book, the point in a reading life at which it is BEST read.

The reader is a British adult reading for themselves, building a lifelong reading order: books that give most when read young come first, books that need more life and more reading behind them are saved for later.

youth (0–100), the age at which the book lands hardest and gives most:
0 = best read at 15–16. 20 = about 18–20. 35 = mid-twenties. 50 = about 30. 65 = about 40. 80 = 50s. 100 = best only after decades of living and reading.

Ask of each book:
- What is lost by reading it too LATE? Books that feed on youthful hunger, restlessness, rebellion, first discovery of ideas or of a culture, or a sense of the world opening up, lose their charge once the reader is settled or has read what came after them.
- What is lost by reading it too EARLY? Books that need lived experience (work, money, love and its failure, marriage, parenthood, illness, loss, ageing, political disappointment), historical context, or earlier books they answer, are wasted or misread when young.
- Ideas books: entry points and manifestos sit earlier; books that argue with a tradition, or that only make sense after the field's basics, sit later.

Do NOT use:
- when schools anywhere assign it, or how commonly teenagers meet it;
- childhood religious, devotional or moral reading (scripture, sermons, allegories once given to children): judge what the adult reader gains and when;
- fame, prestige or ease. Difficulty is a separate measure: a hard book can be young (Nietzsche's Thus Spoke Zarathustra, about 20), an easy one old (Stoner, about 60).

Anchors: The Hitchhiker's Guide to the Galaxy 5. The Catcher in the Rye 5. On the Road 10. Thus Spoke Zarathustra 20. Crime and Punishment 25. Stoner 60. Middlemarch 65. Montaigne's Essays 85.

Use the whole range and compare the books with each other: if two books share a score you should be able to say why they are truly level. Score every book in the list exactly once, by its number. Each reason is one short clause (under 20 words) about the book, never about curricula or reputation."""


class Placing(BaseModel):
    n: int = Field(description="The book's number in the list")
    youth: int = Field(description="0 to 100")
    reason: str


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


def main():
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
        output_config={"effort": "medium"},
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
    helper("stop")
    time.sleep(1)
    cat = json.loads((DATA / "catalogue.json").read_text())
    when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    rows = []
    for i, b in enumerate(books, 1):
        p = got.get(i)
        if not p:
            continue
        sc = cat["entries"]["gr:" + b["goodreadsBookId"]]["score"]
        rows.append((sc.get("youth"), p.youth, b["title"]))
        sc.setdefault("youth_v2", {"youth": sc.get("youth"), "reason": sc.get("youth_reason")})
        sc.update(youth=p.youth, youth_reason=p.reason, youth_model=MODEL, youth_prompt_version=PROMPT_VERSION, youth_scored_at=when)
    (DATA / "catalogue.json").write_text(json.dumps(cat, ensure_ascii=False, indent=1))
    helper("start")
    extra = DATA / "usage-extra.json"          # other models' spending, priced at the time
    log = json.loads(extra.read_text()) if extra.exists() else []
    log.append({"in": u.input_tokens, "out": u.output_tokens, "at": time.time(), "job": "youth-v3", "model": MODEL, "usd": round(spent, 4)})
    extra.write_text(json.dumps(log, indent=1))
    print(f"Wrote youth for {len(rows)} books" + (f"; {len(missing)} missing kept their old score" if missing else "") + ".")


if __name__ == "__main__":
    main()

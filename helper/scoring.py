"""AI difficulty and reading-youth scores (architecture note §6 and §10).

One request per book to the cheapest current model (the user's choice), with a
structured answer, then checks before anything is kept: ranges, the content
score against its components, words-per-page sanity, and reasons that argue from
reputation rather than the text (re-asked once). Nothing here runs without a
cost estimate the user has accepted in the app.
"""
from __future__ import annotations

import re
import os
import pathlib
import time
from typing import Literal

import anthropic
from pydantic import BaseModel, Field

MODEL = "claude-haiku-5-5"
PROMPT_VERSION = 5
# Claude Haiku 5.5, prompts under 100K tokens: $0.10 in / $0.50 out per million.
PRICE_IN, PRICE_OUT = 0.10 / 1e6, 0.50 / 1e6
# Calibrated guesses until real usage replaces them (see estimate()).
EST_IN, EST_OUT = 1500, 1400

def reading_taste() -> str:
    """The reader's own words on when books are good to read, from reading-taste.txt in the
    data folder (yours, never in the repo). Without one, a neutral example stands in."""
    path = pathlib.Path(os.environ.get("ANTILIBRARY_DATA", pathlib.Path.home() / "Library/Application Support/Antilibrary")) / "reading-taste.txt"
    try:
        words = path.read_text().strip()
    except OSError:
        words = ""
    if words:
        return f'In the reader\'s own words: "{words}"'
    return ("For example: books of freedom and first discovery often land early; books that lean on life experience, "
            "history or a lot of earlier reading tend to come later; a short, inviting book can be the right way into a big subject early on.")


SYSTEM = """You estimate how much reading effort a book takes, for a personal reading planner.

You are rating READING SPEED, not merit. A book that is slow to read is not better, more important or more serious than one that is quick to read. Never argue from reputation, prestige, fame, influence or canonical status ("a classic", "a masterpiece", "towering", "seminal"): give reasons that point to features of the text itself.

Rate the TEXT, never the print. Words per page, font size and page count are handled separately by the app from your word estimate, so they must not affect any 1–10 score.

Score four components from 1 to 10 (halves allowed), each with one short sentence of reason:
- lexical: rare, archaic, foreign or specialist vocabulary.
- syntactic: sentence length, embedding, unusual or dense syntax.
- conceptual: abstraction, background knowledge assumed, density of argument.
- structural: fragmented narrative, shifting voices, allusion, formal experiment.

Anchors for the overall content score (use them so scores mean the same across books):
1 = a picture-light children's chapter book.
3 = clear modern prose, e.g. Orwell's essays, a well-written popular history.
5 = literary fiction with some density, e.g. The Name of the Rose in English translation.
7 = sustained argument or ornate style, e.g. Hannah Arendt, Nabokov's Lolita.
9 = dense philosophy in translation, e.g. Nietzsche's The Birth of Tragedy.
10 = Finnegans Wake; late Heidegger.

content: normally the mean of the four components. You may move it by up to 1 point from the mean only if you say why in content_reason.

words: your best estimate of the total words in the text most English-language readers meet (the usual translation for translated books). Give the basis in one short phrase.

youth (0–100): when in a reading life, from about seventeen onwards, this book is going to be good to read: when it will hit hardest, when the reader will be ready for it, and where it fits in a reading life that builds as it goes. Early books are ways in that give energy and appetite; later books ask more and pay back what came before. Not difficulty, not worth, not when schools set it. The age of the narrator or subject doesn't decide it either way. {TASTE} Bands: 0–20 late teens, 20–40 early twenties, 40–60 later twenties, 60–80 thirties, 80–100 forty onwards. In youth_reason, say what the book asks of the reader and what it gives.

If you do not recognise the book with reasonable confidence, set identified to false, give your best estimate from the title, author and year, and set confidence to "low"."""
SYSTEM = SYSTEM.replace("{TASTE}", reading_taste())


class Component(BaseModel):
    score: float = Field(description="1 to 10, halves allowed")
    reason: str = Field(description="One short sentence about the text itself")


class BookScore(BaseModel):
    identified: bool
    words: int = Field(description="Estimated total words in the usual English text")
    words_basis: str
    lexical: Component
    syntactic: Component
    conceptual: Component
    structural: Component
    content: float
    content_reason: str = Field(description="Empty unless content differs from the mean of the components by more than 0.25")
    youth: int = Field(description="0 to 100")
    youth_reason: str
    confidence: Literal["low", "medium", "high"]


PRESTIGE = re.compile(r"\b(masterpiece|classic|canonical|canon|seminal|towering|greatest|monumental|landmark|celebrated|acclaimed|revered|important work|essential reading)\b", re.I)


class ScoreProblem(Exception):
    pass


def user_prompt(book: dict) -> str:
    lines = [f"Title: {book['title']}", f"Author: {book.get('author') or 'unknown'}"]
    if book.get("year"):
        lines.append(f"First published: {book['year']}")
    if book.get("isbn13"):
        lines.append(f"ISBN of the reader's edition: {book['isbn13']}")
    return "\n".join(lines)


def check(s: BookScore, pages: int | None) -> list[str]:
    """Problems that make a score unusable (re-ask) — and flags that are kept but shown."""
    problems = []
    comps = [s.lexical, s.syntactic, s.conceptual, s.structural]
    for c in comps:
        if not 1 <= c.score <= 10:
            problems.append(f"component out of range: {c.score}")
    if not 1 <= s.content <= 10:
        problems.append(f"content out of range: {s.content}")
    mean = sum(c.score for c in comps) / 4
    if abs(s.content - mean) > 1.01:
        problems.append(f"content {s.content} is more than 1 from the components' mean {mean:.2f}")
    if not 0 <= s.youth <= 100:
        problems.append(f"youth out of range: {s.youth}")
    if s.words < 1000:
        problems.append(f"implausible word count: {s.words}")
    reasons = " ".join([c.reason for c in comps] + [s.content_reason, s.youth_reason])
    if PRESTIGE.search(reasons):
        problems.append(f"reason argues from reputation ({PRESTIGE.search(reasons).group(0)!r})")
    return problems


def flags(s: BookScore, pages: int | None) -> list[str]:
    out = []
    if pages:
        wpp = s.words / pages
        if not 180 <= wpp <= 480:
            out.append(f"check page count or word estimate ({round(wpp)} words a page)")
    if not s.identified or s.confidence == "low":
        out.append("low confidence: the model may not know this book")
    return out


def score_book(client: anthropic.Anthropic, book: dict, usage: list) -> dict:
    """Score one book, re-asking once if the answer fails the checks."""
    note = ""
    for attempt in (1, 2):
        msg = user_prompt(book) + (f"\n\nYour previous answer had a problem: {note}. Please correct it." if note else "")
        r = client.messages.parse(
            model=MODEL,
            max_tokens=4000,
            system=SYSTEM,
            output_config={"effort": "medium"},
            messages=[{"role": "user", "content": msg}],
            output_format=BookScore,
        )
        usage.append({"in": r.usage.input_tokens, "out": r.usage.output_tokens, "at": time.time(), "key": book["key"]})
        if r.stop_reason == "refusal":
            raise ScoreProblem("the model declined to score this book")
        s = r.parsed_output
        if s is None:
            note = "the answer was not in the required format"
            continue
        problems = check(s, book.get("pages"))
        if not problems:
            mean = sum(c.score for c in (s.lexical, s.syntactic, s.conceptual, s.structural)) / 4
            return {
                "words": s.words, "words_basis": s.words_basis,
                "C": round(s.content * 2) / 2, "components": {
                    k: {"score": getattr(s, k).score, "reason": getattr(s, k).reason}
                    for k in ("lexical", "syntactic", "conceptual", "structural")},
                "content_reason": s.content_reason or None, "mean": round(mean, 2),
                "youth": s.youth, "youth_reason": s.youth_reason,
                "identified": s.identified, "confidence": s.confidence,
                "flags": flags(s, book.get("pages")),
                "model": MODEL, "prompt_version": PROMPT_VERSION, "scored_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        note = "; ".join(problems)
    raise ScoreProblem(f"the answer failed the checks twice: {note}")


def estimate(n: int, past_usage: list) -> dict:
    """Cost estimate for n books, learning from real usage once there is some."""
    tin, tout = EST_IN, EST_OUT
    if len(past_usage) >= 5:
        tin = sum(u["in"] for u in past_usage) / len(past_usage)
        tout = sum(u["out"] for u in past_usage) / len(past_usage)
    per = tin * PRICE_IN + tout * PRICE_OUT
    return {"books": n, "model": MODEL, "per_book_usd": per, "usd": per * n * 1.1, "learned": len(past_usage) >= 5}


def cost(usage: list) -> float:
    return sum(u["in"] * PRICE_IN + u["out"] * PRICE_OUT for u in usage)

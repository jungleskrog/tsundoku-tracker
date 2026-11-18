import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import scoring
from scoring import BookScore, Component, check, flags, estimate, user_prompt

def make(**kw):
    base = dict(identified=True, words=27000, words_basis="novella", content=3,
                content_reason="", youth=40, youth_reason="Often met in the twenties.", confidence="high",
                lexical=Component(score=3, reason="Plain vocabulary."), syntactic=Component(score=4, reason="Some long sentences."),
                conceptual=Component(score=3, reason="Little background needed."), structural=Component(score=2, reason="A frame narrative."))
    base.update(kw)
    return BookScore(**base)

def test_good_score_passes():
    assert check(make(), 96) == []
    assert flags(make(), 96) == []

def test_content_far_from_mean_is_rejected():
    assert any("more than 1" in p for p in check(make(content=6), 96))

def test_prestige_reason_is_rejected():
    s = make(youth_reason="A towering classic of the century.")
    assert any("reputation" in p for p in check(s, 96))

def test_ranges():
    assert check(make(youth=120), 96)
    assert check(make(lexical=Component(score=11, reason="x")), 96)

def test_words_per_page_flag_and_low_confidence():
    assert "words a page" in flags(make(words=200000), 96)[0]
    assert any("low confidence" in f for f in flags(make(identified=False, confidence="low"), None))

def test_estimate_learns_from_usage():
    first = estimate(100, [])
    assert not first["learned"] and first["usd"] > 0
    learned = estimate(100, [{"in": 1000, "out": 500}] * 5)
    assert learned["learned"]
    assert abs(learned["per_book_usd"] - (1000 * 0.10 + 500 * 0.50) / 1e6) < 1e-12

def test_prompt_has_no_page_count():
    p = user_prompt({"title": "Chess Story", "author": "Stefan Zweig", "year": 1942, "pages": 96})
    assert "96" not in p and "Chess Story" in p

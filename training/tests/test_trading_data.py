import json
from datetime import date, timedelta
from pathlib import Path

from trading_data import Bar, DatasetConfig, build_examples, chronological_split, features


def test_default_config_uses_inkling_renderer() -> None:
    config_path = Path(__file__).parents[1] / "config.example.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    assert config["base_model"] == "thinkingmachines/Inkling"
    assert config["renderer"] == "tml_v0"


def bars(start: date, closes: list[float]) -> list[Bar]:
    return [
        Bar(
            day=start + timedelta(days=index),
            open=close - 0.25,
            high=close + 1,
            low=close - 1,
            close=close,
            volume=1_000 + index * 10,
        )
        for index, close in enumerate(closes)
    ]


def test_features_use_window_values() -> None:
    snapshot = features(bars(date(2025, 1, 1), [100 + index for index in range(21)]))
    assert snapshot["price"] == 120
    assert snapshot["return_20d_pct"] == 20
    assert snapshot["day_return_pct"] > 0


def test_examples_hide_forward_prices_and_split_chronologically() -> None:
    start = date(2025, 1, 1)
    series = {
        "AAA": bars(start, [100 + index for index in range(40)]),
        "BBB": bars(start, [140 - index for index in range(40)]),
    }
    config = DatasetConfig(
        symbols=("AAA", "BBB"),
        start=start,
        end=start + timedelta(days=39),
        lookback_days=20,
        forward_days=5,
        buy_return_pct=1,
        sell_return_pct=-1,
        eval_fraction=0.25,
    )
    examples = build_examples(series, config)
    train, evaluate = chronological_split(examples, config.eval_fraction)
    assert examples
    review_examples = [row for row in examples if row["metadata"]["kind"] == "review"]
    assert {row["metadata"]["verdict"] for row in review_examples} == {"right", "wrong"}
    assert max(row["metadata"]["as_of"] for row in train) < min(
        row["metadata"]["as_of"] for row in evaluate
    )
    for example in examples:
        user_text = example["messages"][1]["content"]
        if example["metadata"]["kind"] == "decision":
            assert "outcome" not in user_text
            assert example["metadata"]["label_day"] not in user_text
        else:
            feedback = json.loads(user_text)
            assert "prior_decision" in feedback
            assert "subsequent_return_pct" in feedback["outcome"]
            assert "position_pnl_if_held_usd_per_1000" in feedback["outcome"]

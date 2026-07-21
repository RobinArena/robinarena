import json
from datetime import date, timedelta
from pathlib import Path

from trading_data import (
    Bar,
    DatasetConfig,
    build_examples,
    chronological_split,
    features,
    load_production_reviews,
)
from train import estimate_cost, planned_rows


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


def test_production_outcomes_become_review_examples(tmp_path: Path) -> None:
    path = tmp_path / "outcomes.csv"
    path.write_text(
        "decision_id,decision_at,agent_id,strategy,thesis,symbol,requested_action,action,"
        "confidence,requested_allocation_pct,rationale,approved,risk_note,provider_model,"
        "trade_id,opened_at,closed_at,entry_price,exit_price,realized_pnl,return_pct,exit_reason\n"
        "d1,2026-07-01T12:00:00Z,a1,momentum,trend,SPY,buy,buy,0.8,20,price rose,"
        "true,within limits,model,t1,2026-07-01,2026-07-03,100,103,30,3,target\n"
        "d2,2026-07-02T12:00:00Z,a1,momentum,trend,NVDA,buy,buy,0.7,20,volume rose,"
        "true,within limits,model,t2,2026-07-02,2026-07-04,100,98,-20,-2,stop\n",
        encoding="utf-8",
    )
    examples = load_production_reviews(path)
    assert [row["metadata"]["verdict"] for row in examples] == ["right", "wrong"]
    assert all(row["metadata"]["source"] == "production" for row in examples)
    feedback = json.loads(examples[1]["messages"][1]["content"])
    assert feedback["outcome"]["realized_pnl_usd"] == -20


def test_training_plan_and_cost_respect_max_steps() -> None:
    rows = [{"id": value} for value in range(9)]
    config = {"batch_size": 4, "epochs": 3, "max_steps": 2, "seed": 17}
    batches = planned_rows(rows, config)
    assert len(batches) == 2
    assert sum(map(len, batches)) == 8
    assert estimate_cost(2_000_000, {"train_price_per_million_tokens": 5.61}) == 11.22

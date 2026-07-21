"""Market data download and leakage-safe RobinArena SFT example generation."""

from __future__ import annotations

import csv
import json
import math
import random
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from statistics import fmean, pstdev
from typing import Any

SYSTEM_PROMPT = (
    "You are a competitor in RobinArena, a long-only trading arena. Choose one action from "
    "buy, sell, or hold using only the supplied historical feature snapshot and portfolio. "
    "A buy must select an unheld symbol. A sell must select the held symbol. Set allocation_pct "
    "from 0 to 40 for buys and 0 for sells or holds. Return one compact JSON object with exactly "
    "action, symbol, confidence, allocation_pct, and rationale. Confidence is from 0 through 1. "
    "Keep rationale specific and under 280 characters. Do not invent news or unavailable data."
)

REVIEW_SYSTEM_PROMPT = (
    "You review a completed RobinArena decision using the supplied subsequent return and PnL. "
    "Return one compact JSON object with exactly verdict, outcome_summary, signal_review, and "
    "lesson. Verdict must be right or wrong. Separate facts known at decision time from the "
    "interpretation that predicted what would happen next. A losing outcome does not make an "
    "accurately reported historical price or indicator false; it can make the inference drawn "
    "from that fact wrong. Do not invent news, fills, or market data."
)


@dataclass(frozen=True)
class Bar:
    day: date
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class DatasetConfig:
    symbols: tuple[str, ...]
    start: date
    end: date
    lookback_days: int = 20
    forward_days: int = 5
    buy_return_pct: float = 2.0
    sell_return_pct: float = -2.0
    eval_fraction: float = 0.1
    seed: int = 17


def parse_date(value: str | None, *, default: date) -> date:
    return date.fromisoformat(value) if value else default


def download_bars(
    symbols: Iterable[str], start: date, end: date, raw_dir: Path
) -> dict[str, list[Bar]]:
    """Download daily OHLCV data with yfinance and cache normalized CSV files."""
    try:
        import yfinance as yf
    except ImportError as exc:
        raise RuntimeError("Install the training dependencies before downloading data") from exc

    raw_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, list[Bar]] = {}
    for original_symbol in symbols:
        symbol = original_symbol.strip().upper()
        cache_path = raw_dir / f"{symbol}.csv"
        frame = yf.Ticker(symbol).history(
            start=start.isoformat(),
            end=(end + timedelta(days=1)).isoformat(),
            auto_adjust=True,
            actions=False,
        )
        if frame.empty:
            raise RuntimeError(f"No market data returned for {symbol}")

        bars: list[Bar] = []
        for timestamp, row in frame.iterrows():
            values = [row.get(name) for name in ("Open", "High", "Low", "Close", "Volume")]
            if any(value is None or not math.isfinite(float(value)) for value in values):
                continue
            bars.append(
                Bar(
                    day=timestamp.date(),
                    open=float(values[0]),
                    high=float(values[1]),
                    low=float(values[2]),
                    close=float(values[3]),
                    volume=float(values[4]),
                )
            )
        if len(bars) < 2:
            raise RuntimeError(f"Insufficient valid market data returned for {symbol}")
        write_bars(cache_path, bars)
        result[symbol] = bars
        print(f"Downloaded {symbol}: {len(bars)} daily bars")
    return result


def write_bars(path: Path, bars: Iterable[Bar]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=["date", "open", "high", "low", "close", "volume"]
        )
        writer.writeheader()
        for bar in bars:
            values = {key: value for key, value in asdict(bar).items() if key != "day"}
            writer.writerow({"date": bar.day.isoformat(), **values})


def read_cached_bars(symbols: Iterable[str], raw_dir: Path) -> dict[str, list[Bar]]:
    result: dict[str, list[Bar]] = {}
    for original_symbol in symbols:
        symbol = original_symbol.strip().upper()
        path = raw_dir / f"{symbol}.csv"
        if not path.exists():
            raise FileNotFoundError(
                f"Missing {path}; run the prepare command without --skip-download"
            )
        with path.open(newline="", encoding="utf-8") as handle:
            rows = csv.DictReader(handle)
            result[symbol] = [
                Bar(
                    day=date.fromisoformat(row["date"]),
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    volume=float(row["volume"]),
                )
                for row in rows
            ]
    return result


def pct_change(current: float, previous: float) -> float:
    return (current / previous - 1) * 100 if previous else 0.0


def round_number(value: float, digits: int = 3) -> float:
    rounded = round(value, digits)
    return 0.0 if rounded == -0.0 else rounded


def features(window: list[Bar]) -> dict[str, float]:
    current = window[-1]
    closes = [bar.close for bar in window]
    volumes = [bar.volume for bar in window]
    daily_returns = [
        pct_change(closes[index], closes[index - 1]) for index in range(1, len(closes))
    ]
    return {
        "price": round_number(current.close, 4),
        "day_return_pct": round_number(pct_change(current.close, closes[-2])),
        "return_5d_pct": round_number(pct_change(current.close, closes[-6])),
        "return_20d_pct": round_number(pct_change(current.close, closes[0])),
        "sma_20_gap_pct": round_number(pct_change(current.close, fmean(closes))),
        "volatility_20d_pct": round_number(pstdev(daily_returns) * math.sqrt(252)),
        "volume_ratio_20d": round_number(current.volume / fmean(volumes)),
        "day_range_pct": round_number(pct_change(current.high, current.low)),
    }


def rationale(action: str, symbol: str, snapshot: dict[str, float]) -> str:
    momentum = snapshot["return_20d_pct"]
    gap = snapshot["sma_20_gap_pct"]
    if action == "buy":
        return (
            f"{symbol} has {momentum:.1f}% 20-day momentum and trades "
            f"{gap:.1f}% versus its 20-day average."
        )
    if action == "sell":
        return (
            f"{symbol} has {momentum:.1f}% 20-day momentum and trades {gap:.1f}% "
            "versus its 20-day average; reduce downside exposure."
        )
    return (
        f"Current price and momentum signals for {symbol} do not justify changing the "
        "portfolio; hold the present allocation."
    )


def decision(
    action: str, symbol: str, forward_return: float, snapshot: dict[str, float]
) -> dict[str, Any]:
    confidence = min(0.95, 0.5 + abs(forward_return) / 20)
    allocation = min(40.0, max(20.0, 20.0 + abs(forward_return) * 2)) if action == "buy" else 0.0
    return {
        "action": action,
        "symbol": symbol,
        "confidence": round_number(confidence, 2),
        "allocation_pct": round_number(allocation, 1),
        "rationale": rationale(action, symbol, snapshot),
    }


def counterfactual_decision(
    action: str, symbol: str, snapshot: dict[str, float]
) -> dict[str, Any]:
    momentum = snapshot["return_20d_pct"]
    gap = snapshot["sma_20_gap_pct"]
    if action == "buy":
        rationale_text = (
            f"{symbol}'s {momentum:.1f}% 20-day move and {gap:.1f}% average-price gap "
            "support an immediate entry and should lead to higher prices."
        )
        allocation = 30.0
    elif action == "sell":
        rationale_text = (
            f"{symbol}'s {momentum:.1f}% 20-day move and {gap:.1f}% average-price gap "
            "look exhausted, so exit before a reversal."
        )
        allocation = 0.0
    else:
        raise ValueError("Counterfactual reviews support buy and sell actions")
    return {
        "action": action,
        "symbol": symbol,
        "confidence": 0.8,
        "allocation_pct": allocation,
        "rationale": rationale_text,
    }


def review_target(
    verdict: str,
    prior_decision: dict[str, Any],
    forward_return: float,
    snapshot: dict[str, float],
) -> dict[str, Any]:
    action = prior_decision["action"]
    symbol = prior_decision["symbol"]
    pnl = forward_return * 10
    interpretation = (
        "The direction implied by the decision matched the later move."
        if verdict == "right"
        else "The direction implied by the decision was contradicted by the later move."
    )
    if action == "hold":
        interpretation = (
            "Waiting was consistent with the configured entry or exit threshold."
            if verdict == "right"
            else "Waiting missed a move large enough to cross the configured action threshold."
        )
    lesson_by_action = {
        "buy": (
            "Keep the entry rule and size discipline."
            if verdict == "right"
            else (
                "Trailing momentum or a reversal story alone was insufficient; require "
                "stronger confirmation."
            )
        ),
        "sell": (
            "Keep the exit rule and reassess the remaining opportunity set."
            if verdict == "right"
            else (
                "The mean-reversion exit thesis was premature; weigh trend persistence "
                "before selling."
            )
        ),
        "hold": (
            "Keep using an explicit edge threshold before changing exposure."
            if verdict == "right"
            else (
                "Recalibrate the action threshold when the available move is economically "
                "meaningful."
            )
        ),
    }
    return {
        "verdict": verdict,
        "outcome_summary": (
            f"{symbol} returned {forward_return:.2f}% over the review window, equal to "
            f"${pnl:.2f} per $1,000 held. {interpretation}"
        ),
        "signal_review": (
            f"The observed 20-day return of {snapshot['return_20d_pct']:.2f}% and "
            f"20-day average gap of {snapshot['sma_20_gap_pct']:.2f}% were input facts. "
            f"Their predictive interpretation was {verdict}."
        ),
        "lesson": lesson_by_action[action],
    }


def review_conversation(
    prompt: dict[str, Any],
    prior_decision: dict[str, Any],
    forward_return: float,
    snapshot: dict[str, float],
    verdict: str,
    as_of: date,
    label_day: date,
) -> dict[str, Any]:
    feedback = {
        "type": "decision_outcome",
        "decision_as_of": as_of.isoformat(),
        "outcome_as_of": label_day.isoformat(),
        "market_context_at_decision": prompt,
        "prior_decision": prior_decision,
        "outcome": {
            "symbol": prior_decision["symbol"],
            "subsequent_return_pct": round_number(forward_return),
            "position_pnl_if_held_usd_per_1000": round_number(forward_return * 10, 2),
        },
    }
    target = review_target(verdict, prior_decision, forward_return, snapshot)
    return {
        "messages": [
            {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(feedback, separators=(",", ":"), sort_keys=True),
            },
            {
                "role": "assistant",
                "content": json.dumps(target, separators=(",", ":"), sort_keys=True),
            },
        ],
        "metadata": {
            "as_of": as_of.isoformat(),
            "label_day": label_day.isoformat(),
            "kind": "review",
            "verdict": verdict,
        },
    }


def load_production_reviews(path: Path) -> list[dict[str, Any]]:
    """Convert closed production trades into decision-outcome review conversations."""
    if not path.exists():
        raise FileNotFoundError(f"Missing production outcome export: {path}")

    examples: list[dict[str, Any]] = []
    seen: set[str] = set()
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            decision_id = row.get("decision_id", "").strip()
            if not decision_id or decision_id in seen:
                continue
            seen.add(decision_id)
            action = (row.get("action") or row.get("requested_action") or "hold").lower()
            symbol = (row.get("symbol") or "UNKNOWN").upper()
            realized_pnl = float(row.get("realized_pnl") or 0)
            return_pct = float(row.get("return_pct") or 0)
            verdict = "right" if realized_pnl > 0 else "wrong"
            rationale_text = row.get("rationale") or "No rationale was recorded."
            prior_decision = {
                "action": action,
                "symbol": symbol,
                "confidence": float(row.get("confidence") or 0),
                "allocation_pct": float(row.get("requested_allocation_pct") or 0),
                "rationale": rationale_text,
            }
            feedback = {
                "type": "production_decision_outcome",
                "decision_id": decision_id,
                "decision_context": {
                    "agent_id": row.get("agent_id"),
                    "strategy": row.get("strategy"),
                    "thesis": row.get("thesis"),
                    "provider_model": row.get("provider_model"),
                    "risk_note": row.get("risk_note"),
                },
                "prior_decision": prior_decision,
                "outcome": {
                    "trade_id": row.get("trade_id"),
                    "opened_at": row.get("opened_at"),
                    "closed_at": row.get("closed_at"),
                    "entry_price": float(row.get("entry_price") or 0),
                    "exit_price": float(row.get("exit_price") or 0),
                    "realized_pnl_usd": realized_pnl,
                    "return_pct": return_pct,
                    "exit_reason": row.get("exit_reason"),
                },
            }
            result_text = "earned" if realized_pnl > 0 else "lost"
            target = {
                "verdict": verdict,
                "outcome_summary": (
                    f"The {action} decision on {symbol} {result_text} ${abs(realized_pnl):.2f} "
                    f"with a {return_pct:.2f}% realized return."
                ),
                "signal_review": (
                    f"The recorded rationale was available at decision time: {rationale_text} "
                    f"The realized PnL shows that its directional interpretation was {verdict}."
                ),
                "lesson": (
                    "Retain the useful signal and sizing discipline from this profitable decision."
                    if verdict == "right"
                    else (
                        "Treat the recorded inputs as historical facts and revise the inference or "
                        "risk rule that turned them into this losing decision."
                    )
                ),
            }
            decision_at = (row.get("decision_at") or row.get("opened_at") or "")[:10]
            closed_at = (row.get("closed_at") or decision_at)[:10]
            examples.append(
                {
                    "messages": [
                        {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": json.dumps(feedback, separators=(",", ":"), sort_keys=True),
                        },
                        {
                            "role": "assistant",
                            "content": json.dumps(target, separators=(",", ":"), sort_keys=True),
                        },
                    ],
                    "metadata": {
                        "as_of": decision_at,
                        "label_day": closed_at,
                        "kind": "review",
                        "source": "production",
                        "decision_id": decision_id,
                        "verdict": verdict,
                    },
                }
            )
    return examples


def build_examples(
    bars_by_symbol: dict[str, list[Bar]], config: DatasetConfig
) -> list[dict[str, Any]]:
    """Create examples on common dates. Future prices are used for targets and never prompts."""
    indexed = {symbol: {bar.day: bar for bar in bars} for symbol, bars in bars_by_symbol.items()}
    common_days = sorted(set.intersection(*(set(rows) for rows in indexed.values())))
    required_history = config.lookback_days + 1
    if len(common_days) <= required_history + config.forward_days:
        raise ValueError("Not enough common trading days for the configured lookback and horizon")

    examples: list[dict[str, Any]] = []
    for index in range(required_history - 1, len(common_days) - config.forward_days):
        day = common_days[index]
        history_days = common_days[index - config.lookback_days : index + 1]
        future_day = common_days[index + config.forward_days]
        market: list[dict[str, Any]] = []
        forward_returns: dict[str, float] = {}
        feature_map: dict[str, dict[str, float]] = {}
        for symbol in config.symbols:
            window = [indexed[symbol][history_day] for history_day in history_days]
            symbol_features = features(window)
            feature_map[symbol] = symbol_features
            market.append({"symbol": symbol, **symbol_features})
            forward_returns[symbol] = pct_change(
                indexed[symbol][future_day].close, indexed[symbol][day].close
            )

        best_symbol = max(config.symbols, key=forward_returns.__getitem__)
        best_return = forward_returns[best_symbol]
        worst_symbol = min(config.symbols, key=forward_returns.__getitem__)
        worst_return = forward_returns[worst_symbol]
        cash_action = "buy" if best_return >= config.buy_return_pct else "hold"
        cash_prompt = {
            "as_of": day.isoformat(),
            "portfolio": {"cash_pct": 100, "positions": []},
            "market": market,
        }
        cash_target = decision(
            cash_action, best_symbol, best_return, feature_map[best_symbol]
        )
        examples.append(conversation(cash_prompt, cash_target, day, future_day))
        examples.append(
            review_conversation(
                cash_prompt,
                cash_target,
                best_return,
                feature_map[best_symbol],
                "right",
                day,
                future_day,
            )
        )

        if forward_returns[worst_symbol] <= config.sell_return_pct:
            bad_buy = counterfactual_decision("buy", worst_symbol, feature_map[worst_symbol])
            examples.append(
                review_conversation(
                    cash_prompt,
                    bad_buy,
                    forward_returns[worst_symbol],
                    feature_map[worst_symbol],
                    "wrong",
                    day,
                    future_day,
                )
            )

        held_action = "sell" if worst_return <= config.sell_return_pct else "hold"
        held_prompt = {
            "as_of": day.isoformat(),
            "portfolio": {
                "cash_pct": 60,
                "positions": [{"symbol": worst_symbol, "allocation_pct": 40}],
            },
            "market": market,
        }
        held_target = decision(
            held_action, worst_symbol, worst_return, feature_map[worst_symbol]
        )
        examples.append(conversation(held_prompt, held_target, day, future_day))
        examples.append(
            review_conversation(
                held_prompt,
                held_target,
                worst_return,
                feature_map[worst_symbol],
                "right",
                day,
                future_day,
            )
        )

        if forward_returns[best_symbol] >= config.buy_return_pct:
            bad_sell = counterfactual_decision("sell", best_symbol, feature_map[best_symbol])
            bad_sell_prompt = {
                "as_of": day.isoformat(),
                "portfolio": {
                    "cash_pct": 60,
                    "positions": [{"symbol": best_symbol, "allocation_pct": 40}],
                },
                "market": market,
            }
            examples.append(
                review_conversation(
                    bad_sell_prompt,
                    bad_sell,
                    forward_returns[best_symbol],
                    feature_map[best_symbol],
                    "wrong",
                    day,
                    future_day,
                )
            )
    return examples


def conversation(
    prompt: dict[str, Any], target: dict[str, Any], as_of: date, label_day: date
) -> dict[str, Any]:
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(prompt, separators=(",", ":"), sort_keys=True)},
            {
                "role": "assistant",
                "content": json.dumps(target, separators=(",", ":"), sort_keys=True),
            },
        ],
        "metadata": {
            "as_of": as_of.isoformat(),
            "label_day": label_day.isoformat(),
            "kind": "decision",
        },
    }


def chronological_split(
    examples: list[dict[str, Any]], eval_fraction: float
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not 0 < eval_fraction < 1:
        raise ValueError("eval_fraction must be between 0 and 1")
    days = sorted({example["metadata"]["as_of"] for example in examples})
    eval_day_count = max(1, math.ceil(len(days) * eval_fraction))
    first_eval_day = days[-eval_day_count]
    train = [example for example in examples if example["metadata"]["as_of"] < first_eval_day]
    evaluate = [example for example in examples if example["metadata"]["as_of"] >= first_eval_day]
    if not train or not evaluate:
        raise ValueError("Chronological split produced an empty dataset")
    return train, evaluate


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n")
            count += 1
    return count


def dataset_summary(train: list[dict[str, Any]], evaluate: list[dict[str, Any]]) -> dict[str, Any]:
    def actions(rows: list[dict[str, Any]]) -> dict[str, int]:
        counts = {"buy": 0, "sell": 0, "hold": 0}
        for row in rows:
            if row["metadata"]["kind"] != "decision":
                continue
            target = json.loads(row["messages"][-1]["content"])
            counts[target["action"]] += 1
        return counts

    def verdicts(rows: list[dict[str, Any]]) -> dict[str, int]:
        counts = {"right": 0, "wrong": 0}
        for row in rows:
            verdict = row["metadata"].get("verdict")
            if verdict in counts:
                counts[verdict] += 1
        return counts

    return {
        "created_at": datetime.now(UTC).isoformat(),
        "train_examples": len(train),
        "eval_examples": len(evaluate),
        "train_actions": actions(train),
        "eval_actions": actions(evaluate),
        "train_review_verdicts": verdicts(train),
        "eval_review_verdicts": verdicts(evaluate),
        "last_train_day": max(row["metadata"]["as_of"] for row in train),
        "first_eval_day": min(row["metadata"]["as_of"] for row in evaluate),
        "last_label_day": max(
            row["metadata"]["label_day"] for row in [*train, *evaluate]
        ),
        "production_review_examples": sum(
            row["metadata"].get("source") == "production" for row in train
        ),
    }


def shuffled(rows: list[dict[str, Any]], seed: int) -> list[dict[str, Any]]:
    copied = list(rows)
    random.Random(seed).shuffle(copied)
    return copied

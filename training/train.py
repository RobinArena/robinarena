#!/usr/bin/env python3
"""Prepare, inspect, estimate, and run a Tinker trading-model fine-tune."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from dataclasses import fields
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from trading_data import (
    DatasetConfig,
    build_examples,
    chronological_split,
    dataset_summary,
    download_bars,
    identity_examples,
    load_production_reviews,
    parse_date,
    read_cached_bars,
    shuffled,
    write_jsonl,
)

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "config.json"
EXAMPLE_CONFIG = ROOT / "config.example.json"
PROCESSED_DIR = ROOT / "data" / "processed"
PRODUCTION_OUTCOMES = ROOT / "data" / "production" / "decision-outcomes.csv"


def relaunch_in_project_environment() -> None:
    """Use the local training environment when the command starts with system Python."""
    venv_python = ROOT / ".venv" / "bin" / "python"
    if not venv_python.exists() or Path(sys.prefix) == ROOT / ".venv":
        return
    environment = os.environ.copy()
    environment["VIRTUAL_ENV"] = str(ROOT / ".venv")
    environment["PATH"] = f"{venv_python.parent}{os.pathsep}{environment.get('PATH', '')}"
    os.execve(
        str(venv_python),
        [str(venv_python), str(Path(__file__).resolve()), *sys.argv[1:]],
        environment,
    )


class Console:
    COLORS = {
        "cyan": "\033[36m",
        "green": "\033[32m",
        "yellow": "\033[33m",
        "red": "\033[31m",
        "magenta": "\033[35m",
        "bold": "\033[1m",
        "dim": "\033[2m",
        "reset": "\033[0m",
    }

    def __init__(self, *, disabled: bool = False) -> None:
        self.enabled = sys.stdout.isatty() and not disabled and "NO_COLOR" not in os.environ

    def paint(self, value: object, color: str) -> str:
        text = str(value)
        if not self.enabled:
            return text
        return f"{self.COLORS[color]}{text}{self.COLORS['reset']}"

    def title(self, text: str) -> None:
        print(f"\n{self.paint(text, 'bold')}")

    def status(self, label: str, text: str, color: str = "cyan") -> None:
        print(f"{self.paint(label.ljust(12), color)} {text}")

    def value(self, label: str, value: object, *, color: str = "cyan") -> None:
        print(f"  {self.paint(label.ljust(25), 'dim')} {self.paint(value, color)}")


def load_config(path: Path, console: Console) -> dict[str, Any]:
    source = path if path.exists() else EXAMPLE_CONFIG
    with source.open(encoding="utf-8") as handle:
        config = json.load(handle)
    if source == EXAMPLE_CONFIG:
        console.status(
            "CONFIG", f"Using {EXAMPLE_CONFIG.name}; copy it to config.json to customize"
        )
    return config


def data_config(raw: dict[str, Any]) -> DatasetConfig:
    today = date.today()
    allowed = {field.name for field in fields(DatasetConfig)}
    values = {key: value for key, value in raw.items() if key in allowed}
    values["symbols"] = tuple(symbol.strip().upper() for symbol in raw["symbols"])
    values["start"] = parse_date(raw.get("start"), default=today - timedelta(days=365 * 5))
    values["end"] = parse_date(raw.get("end"), default=today)
    return DatasetConfig(**values)


def production_query() -> str:
    return """COPY (
SELECT d.id AS decision_id, d.created_at AS decision_at, d.agent_id,
       a.strategy, a.thesis, d.symbol, d.requested_action, d.action,
       d.confidence, d.requested_allocation_pct, d.rationale, d.approved,
       d.risk_note, d.provider_model, t.id AS trade_id, t.opened_at,
       t.closed_at, t.entry_price, t.exit_price, t.realized_pnl,
       t.return_pct, t.exit_reason
FROM arena_decisions d
JOIN arena_agents a ON a.id = d.agent_id
JOIN arena_trades t ON t.source_order_id = d.order_id
WHERE t.status = 'closed' AND t.realized_pnl IS NOT NULL
ORDER BY d.created_at
) TO STDOUT WITH (FORMAT CSV, HEADER TRUE)"""


def sync_production_outcomes(raw: dict[str, Any], console: Console) -> int:
    config = raw.get("production_data", {})
    host = str(config.get("ssh_host", "root@dokploy.nik.technology"))
    service = str(config.get("container_name", "robinshark-postgres"))
    database_user = str(config.get("database_user", "nstack"))
    database_name = str(config.get("database_name", "app"))
    console.status("PRODUCTION", f"Fetching closed decision outcomes from {host}")
    lookup = subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            host,
            "docker",
            "ps",
            "--filter",
            f"name={service}",
            "--format",
            "{{.ID}}",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    containers = [line.strip() for line in lookup.stdout.splitlines() if line.strip()]
    valid_id = len(containers) == 1 and all(
        character in "0123456789abcdef" for character in containers[0]
    )
    if not valid_id:
        raise RuntimeError(f"Expected one running {service} container, found {len(containers)}")
    exported = subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            host,
            "docker",
            "exec",
            "-i",
            containers[0],
            "psql",
            "--no-psqlrc",
            "--quiet",
            "-U",
            database_user,
            "-d",
            database_name,
        ],
        check=True,
        capture_output=True,
        input=production_query() + ";\n",
        text=True,
        timeout=60,
    )
    lines = [line for line in exported.stdout.splitlines() if line.strip()]
    if not lines or not lines[0].startswith("decision_id,"):
        raise RuntimeError("Production export did not return the expected CSV header")
    PRODUCTION_OUTCOMES.parent.mkdir(parents=True, exist_ok=True)
    temporary = PRODUCTION_OUTCOMES.with_suffix(".csv.tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    temporary.replace(PRODUCTION_OUTCOMES)
    count = max(0, len(lines) - 1)
    console.status("SYNCED", f"{count:,} closed production outcomes", "green")
    return count


def show_summary(summary: dict[str, Any], console: Console) -> None:
    console.title("Dataset")
    console.value("Generated", summary["created_at"])
    console.value("Training examples", f"{summary['train_examples']:,}", color="green")
    console.value("Evaluation examples", f"{summary['eval_examples']:,}")
    console.value("Production outcomes", summary.get("production_review_examples", 0))
    console.value("Identity examples", summary.get("identity_examples", 0))
    console.value("Latest market label", summary.get("last_market_label_day", "unknown"))
    console.value("Latest production label", summary.get("last_production_label_day", "none"))
    console.value("Eval starts", summary["first_eval_day"])
    console.value("Train actions", json.dumps(summary["train_actions"], sort_keys=True))
    console.value(
        "Train review verdicts",
        json.dumps(summary["train_review_verdicts"], sort_keys=True),
    )


def prepare(
    raw: dict[str, Any],
    console: Console,
    *,
    skip_download: bool,
    skip_production_sync: bool,
) -> dict[str, Any]:
    config = data_config(raw)
    if config.start >= config.end:
        raise ValueError("start must be earlier than end")
    console.title("Refresh training dataset")
    console.status("MARKET", f"{len(config.symbols)} symbols through {config.end.isoformat()}")
    raw_dir = ROOT / "data" / "raw"
    bars = (
        read_cached_bars(config.symbols, raw_dir)
        if skip_download
        else download_bars(config.symbols, config.start, config.end, raw_dir)
    )
    if skip_production_sync:
        console.status("PRODUCTION", "Using cached decision outcomes", "yellow")
    else:
        sync_production_outcomes(raw, console)

    historical = build_examples(bars, config)
    train_rows, eval_rows = chronological_split(historical, config.eval_fraction)
    production_rows = (
        load_production_reviews(PRODUCTION_OUTCOMES) if PRODUCTION_OUTCOMES.exists() else []
    )
    train_rows.extend(production_rows)
    train_rows.extend(identity_examples())
    write_jsonl(PROCESSED_DIR / "train.jsonl", train_rows)
    write_jsonl(PROCESSED_DIR / "eval.jsonl", eval_rows)
    summary = dataset_summary(train_rows, eval_rows)
    market_labels = [row["metadata"]["label_day"] for row in historical]
    production_labels = [row["metadata"]["label_day"] for row in production_rows]
    summary["last_market_label_day"] = max(market_labels)
    summary["last_production_label_day"] = max(production_labels) if production_labels else None
    summary["production_export"] = str(PRODUCTION_OUTCOMES.relative_to(ROOT))
    (PROCESSED_DIR / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    console.status("READY", "Processed dataset written", "green")
    show_summary(summary, console)
    return summary


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}; refresh the dataset first")
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def inspect_dataset(console: Console) -> dict[str, Any]:
    path = PROCESSED_DIR / "summary.json"
    if not path.exists():
        raise FileNotFoundError("No processed dataset found; run prepare")
    summary = json.loads(path.read_text(encoding="utf-8"))
    show_summary(summary, console)
    created = datetime.fromisoformat(summary["created_at"])
    age = datetime.now(UTC) - created
    if age > timedelta(days=1):
        console.status("STALE", f"Dataset was generated {age.days} day(s) ago", "yellow")
    else:
        console.status("FRESH", "Dataset was generated within the last 24 hours", "green")
    return summary


def planned_rows(
    train_rows: list[dict[str, Any]], raw: dict[str, Any]
) -> list[list[dict[str, Any]]]:
    batch_size = int(raw["batch_size"])
    max_steps_value = raw.get("max_steps")
    max_steps = int(max_steps_value) if max_steps_value is not None else None
    batches: list[list[dict[str, Any]]] = []
    for epoch in range(int(raw["epochs"])):
        rows = shuffled(train_rows, int(raw["seed"]) + epoch)
        for start in range(0, len(rows), batch_size):
            if max_steps is not None and len(batches) >= max_steps:
                return batches
            batches.append(rows[start : start + batch_size])
    return batches


def estimate_cost(token_count: int, raw: dict[str, Any]) -> float:
    return token_count / 1_000_000 * float(raw["train_price_per_million_tokens"])


async def train(raw: dict[str, Any], console: Console, *, dry_run: bool, yes: bool) -> None:
    try:
        import numpy as np
        import tinker
        from tinker_cookbook.renderers import TrainOnWhat, get_renderer
        from tinker_cookbook.supervised.data import conversation_to_datum
        from tinker_cookbook.tokenizer_utils import get_tokenizer
    except ImportError as exc:
        raise RuntimeError("Install the training dependencies before running train") from exc

    train_rows = read_jsonl(PROCESSED_DIR / "train.jsonl")
    if not train_rows:
        raise ValueError("Training dataset is empty")
    tokenizer = get_tokenizer(raw["base_model"])
    renderer = get_renderer(raw["renderer"], tokenizer)
    max_length = int(raw["max_length"])
    row_batches = planned_rows(train_rows, raw)
    datum_batches = [
        [
            conversation_to_datum(
                row["messages"],
                renderer,
                max_length=max_length,
                train_on_what=TrainOnWhat.LAST_ASSISTANT_MESSAGE,
            )
            for row in batch
        ]
        for batch in row_batches
    ]
    token_count = sum(datum.model_input.length for batch in datum_batches for datum in batch)
    cost = estimate_cost(token_count, raw)
    console.title("Training estimate")
    console.value("Model", raw["base_model"], color="magenta")
    console.value("Optimizer steps", f"{len(datum_batches):,}")
    console.value("Rendered examples", f"{sum(map(len, row_batches)):,}")
    console.value("Training tokens", f"{token_count:,}")
    rate = float(raw["train_price_per_million_tokens"])
    console.value("Configured token rate", f"${rate:.2f} / 1M")
    console.value("Estimated training cost", f"${cost:.2f}", color="green")
    console.value("Pricing checked", raw["pricing_checked_at"])
    print(console.paint("  Excludes sampling, storage, taxes, and future price changes.", "dim"))
    if dry_run:
        console.status("DRY RUN", "No paid Tinker client was created", "green")
        return
    if not os.environ.get("TINKER_API_KEY"):
        raise RuntimeError("Set TINKER_API_KEY before starting a paid Tinker training run")
    if not yes:
        if not sys.stdin.isatty():
            raise RuntimeError("Paid training requires --yes in a non-interactive shell")
        answer = input(console.paint("Start this paid training run? [y/N] ", "yellow"))
        if answer.strip().lower() not in {"y", "yes"}:
            console.status("CANCELLED", "No paid Tinker client was created", "yellow")
            return

    service_client = tinker.ServiceClient()
    training_client = await service_client.create_lora_training_client_async(
        base_model=raw["base_model"], rank=int(raw["lora_rank"])
    )
    checkpoint_every = int(raw["checkpoint_every"])
    for step, batch in enumerate(datum_batches, start=1):
        forward_future = await training_client.forward_backward_async(batch, "cross_entropy")
        optimizer_future = await training_client.optim_step_async(
            tinker.AdamParams(learning_rate=float(raw["learning_rate"]))
        )
        forward_result = await forward_future.result_async()
        await optimizer_future.result_async()
        logprobs = np.concatenate(
            [output["logprobs"].tolist() for output in forward_result.loss_fn_outputs]
        )
        weights = np.concatenate([datum.loss_fn_inputs["weights"].tolist() for datum in batch])
        loss = float(-np.dot(logprobs, weights) / weights.sum())
        console.status(
            "TRAIN",
            f"step {step:,}/{len(datum_batches):,}  examples {len(batch)}  loss {loss:.4f}",
            "magenta",
        )
        if checkpoint_every > 0 and step % checkpoint_every == 0:
            checkpoint = await (
                await training_client.save_state_async(name=f"step-{step}")
            ).result_async()
            console.status("CHECKPOINT", checkpoint.path, "green")

    if not datum_batches:
        raise ValueError("No training steps planned; check batch_size and max_steps")
    final_step = len(datum_batches)
    final_state = await (
        await training_client.save_state_async(name=f"final-step-{final_step}")
    ).result_async()
    sampler_weights = await (
        await training_client.save_weights_for_sampler_async(name=f"sampler-step-{final_step}")
    ).result_async()
    console.title("Training complete")
    console.value("Resumable checkpoint", final_state.path, color="green")
    console.value("Sampler weights", sampler_weights.path, color="green")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "inspect", "train", "all"))
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI colors")
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Use cached market CSV files",
    )
    parser.add_argument(
        "--skip-production-sync",
        action="store_true",
        help="Use the cached production outcome export",
    )
    parser.add_argument(
        "--use-existing-data",
        action="store_true",
        help="Train from processed JSONL without refreshing market or production data",
    )
    parser.add_argument("--dry-run", action="store_true", help="Estimate cost without training")
    parser.add_argument("--yes", action="store_true", help="Confirm the paid training run")
    return parser.parse_args()


def main() -> None:
    relaunch_in_project_environment()
    args = arguments()
    console = Console(disabled=args.no_color)
    try:
        raw = load_config(args.config, console)
        should_prepare = args.command in {"prepare", "all"} or (
            args.command == "train" and not args.use_existing_data
        )
        if should_prepare:
            prepare(
                raw,
                console,
                skip_download=args.skip_download,
                skip_production_sync=args.skip_production_sync,
            )
        elif args.command == "inspect":
            inspect_dataset(console)
        if args.command in {"train", "all"}:
            asyncio.run(train(raw, console, dry_run=args.dry_run, yes=args.yes))
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        console.status("ERROR", str(exc), "red")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()

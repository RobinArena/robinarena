#!/usr/bin/env python3
"""Prepare trading conversations and run a Tinker LoRA supervised fine-tune."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from dataclasses import fields
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from trading_data import (
    DatasetConfig,
    build_examples,
    chronological_split,
    dataset_summary,
    download_bars,
    parse_date,
    read_cached_bars,
    shuffled,
    write_jsonl,
)

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "config.json"
EXAMPLE_CONFIG = ROOT / "config.example.json"


def load_config(path: Path) -> dict[str, Any]:
    source = path if path.exists() else EXAMPLE_CONFIG
    with source.open(encoding="utf-8") as handle:
        config = json.load(handle)
    if source == EXAMPLE_CONFIG:
        print(f"Using defaults from {EXAMPLE_CONFIG.name}; copy it to config.json to customize")
    return config


def data_config(raw: dict[str, Any]) -> DatasetConfig:
    today = date.today()
    allowed = {field.name for field in fields(DatasetConfig)}
    values = {key: value for key, value in raw.items() if key in allowed}
    values["symbols"] = tuple(symbol.strip().upper() for symbol in raw["symbols"])
    values["start"] = parse_date(raw.get("start"), default=today - timedelta(days=365 * 5))
    values["end"] = parse_date(raw.get("end"), default=today - timedelta(days=1))
    return DatasetConfig(**values)


def prepare(raw: dict[str, Any], *, skip_download: bool) -> None:
    config = data_config(raw)
    if config.start >= config.end:
        raise ValueError("start must be earlier than end")
    raw_dir = ROOT / "data" / "raw"
    processed_dir = ROOT / "data" / "processed"
    bars = (
        read_cached_bars(config.symbols, raw_dir)
        if skip_download
        else download_bars(config.symbols, config.start, config.end, raw_dir)
    )
    examples = build_examples(bars, config)
    train_rows, eval_rows = chronological_split(examples, config.eval_fraction)
    train_count = write_jsonl(processed_dir / "train.jsonl", train_rows)
    eval_count = write_jsonl(processed_dir / "eval.jsonl", eval_rows)
    summary = dataset_summary(train_rows, eval_rows)
    (processed_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Prepared {train_count} training and {eval_count} evaluation examples")
    print(json.dumps(summary, indent=2))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}; run prepare first")
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


async def train(raw: dict[str, Any]) -> None:
    if not os.environ.get("TINKER_API_KEY"):
        raise RuntimeError("Set TINKER_API_KEY before starting a paid Tinker training run")
    try:
        import numpy as np
        import tinker
        from tinker_cookbook.renderers import TrainOnWhat, get_renderer
        from tinker_cookbook.supervised.data import conversation_to_datum
    except ImportError as exc:
        raise RuntimeError("Install the training dependencies before running train") from exc

    train_rows = read_jsonl(ROOT / "data" / "processed" / "train.jsonl")
    if not train_rows:
        raise ValueError("Training dataset is empty")
    service_client = tinker.ServiceClient()
    training_client = await service_client.create_lora_training_client_async(
        base_model=raw["base_model"], rank=int(raw["lora_rank"])
    )
    tokenizer = training_client.get_tokenizer()
    renderer = get_renderer(raw["renderer"], tokenizer)
    max_length = int(raw["max_length"])
    batch_size = int(raw["batch_size"])
    checkpoint_every = int(raw["checkpoint_every"])
    max_steps = raw.get("max_steps")
    max_steps = int(max_steps) if max_steps is not None else None
    global_step = 0

    for epoch in range(int(raw["epochs"])):
        rows = shuffled(train_rows, int(raw["seed"]) + epoch)
        for start in range(0, len(rows), batch_size):
            if max_steps is not None and global_step >= max_steps:
                break
            batch_rows = rows[start : start + batch_size]
            batch = [
                conversation_to_datum(
                    row["messages"],
                    renderer,
                    max_length=max_length,
                    train_on_what=TrainOnWhat.LAST_ASSISTANT_MESSAGE,
                )
                for row in batch_rows
            ]
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
            global_step += 1
            print(f"epoch={epoch + 1} step={global_step} examples={len(batch)} loss={loss:.4f}")
            if checkpoint_every > 0 and global_step % checkpoint_every == 0:
                checkpoint_future = await training_client.save_state_async(
                    name=f"step-{global_step}"
                )
                checkpoint = await checkpoint_future.result_async()
                print(f"Saved resumable checkpoint: {checkpoint.path}")
        if max_steps is not None and global_step >= max_steps:
            break

    if global_step == 0:
        raise ValueError("No training steps ran; check batch_size and max_steps")
    final_state_future = await training_client.save_state_async(name=f"final-step-{global_step}")
    final_state = await final_state_future.result_async()
    sampler_future = await training_client.save_weights_for_sampler_async(
        name=f"sampler-step-{global_step}"
    )
    sampler_weights = await sampler_future.result_async()
    print(f"Final resumable checkpoint: {final_state.path}")
    print(f"Sampler weights: {sampler_weights.path}")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "train", "all"))
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Build examples from data/raw CSV files without requesting Yahoo Finance",
    )
    return parser.parse_args()


def main() -> None:
    args = arguments()
    raw = load_config(args.config)
    if args.command in {"prepare", "all"}:
        prepare(raw, skip_download=args.skip_download)
    if args.command in {"train", "all"}:
        asyncio.run(train(raw))


if __name__ == "__main__":
    main()

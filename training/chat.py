#!/usr/bin/env python3
"""Chat with the TradeFinder 1 sampler checkpoint on Tinker."""

from __future__ import annotations

import argparse
import asyncio
import os
import time
from pathlib import Path
from typing import Any

from train import (
    Console,
    await_with_heartbeat,
    create_tinker_service_client,
    load_config,
    relaunch_in_project_environment,
)

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "config.json"
DEFAULT_CHECKPOINT = (
    "tinker://7613dcda-5329-5a58-a3fb-22709db35383:train:0/"
    "sampler_weights/sampler-step-671"
)
SYSTEM_PROMPT = (
    "You are TradeFinder 1, an AI model by RobinArena. Help analyze trading decisions "
    "carefully. Distinguish observations from inferences, quantify uncertainty, and never "
    "claim that a trade is guaranteed."
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="*", help="Send one prompt and exit")
    parser.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--system", default=SYSTEM_PROMPT)
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--top-p", type=float, default=0.95)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--no-color", action="store_true")
    return parser.parse_args()


async def sample_message(
    sampling_client: Any,
    renderer: Any,
    messages: list[dict[str, Any]],
    args: argparse.Namespace,
    console: Console,
) -> str:
    import tinker
    from tinker_cookbook.renderers import get_text_content

    model_input = renderer.build_generation_prompt(messages)
    started_at = time.monotonic()
    response = await await_with_heartbeat(
        sampling_client.sample_async(
            prompt=model_input,
            num_samples=1,
            sampling_params=tinker.SamplingParams(
                max_tokens=args.max_tokens,
                seed=args.seed,
                stop=renderer.get_stop_sequences(),
                temperature=args.temperature,
                top_p=args.top_p,
            ),
        ),
        console,
        "THINKING",
        "Waiting for TradeFinder 1",
    )
    if not response.sequences:
        raise RuntimeError("Tinker returned no samples")
    message, _ = renderer.parse_response(response.sequences[0].tokens)
    answer = get_text_content(message).strip()
    console.status(
        "RESPONSE",
        f"{len(response.sequences[0].tokens):,} tokens in {time.monotonic() - started_at:,.1f}s",
        "green",
    )
    return answer


async def chat(args: argparse.Namespace, console: Console) -> None:
    try:
        from tinker_cookbook.renderers import get_renderer
        from tinker_cookbook.tokenizer_utils import get_tokenizer
    except ImportError as exc:
        raise RuntimeError("Install the training dependencies before running chat.py") from exc

    if not os.environ.get("TINKER_API_KEY"):
        raise RuntimeError("Set TINKER_API_KEY before using the Tinker sampler")
    if args.max_tokens < 1:
        raise ValueError("--max-tokens must be positive")
    if not 0 <= args.temperature:
        raise ValueError("--temperature must be non-negative")
    if not 0 < args.top_p <= 1:
        raise ValueError("--top-p must be greater than 0 and at most 1")

    raw = load_config(args.config, console)
    tokenizer = get_tokenizer(raw["base_model"])
    renderer = get_renderer(raw["renderer"], tokenizer, model_name=raw["base_model"])
    console.status("CONNECT", "Loading TradeFinder 1 sampler checkpoint", "magenta")
    service_client = await create_tinker_service_client(raw, console)
    sampling_client = await await_with_heartbeat(
        asyncio.to_thread(service_client.create_sampling_client, model_path=args.checkpoint),
        console,
        "CONNECT",
        "Waiting for Tinker to load the sampler",
    )
    console.status("READY", "TradeFinder 1 is ready. Commands: /clear, /quit", "green")

    history: list[dict[str, Any]] = [{"role": "system", "content": args.system}]
    one_shot = " ".join(args.prompt).strip()
    while True:
        if one_shot:
            user_text = one_shot
            one_shot = ""
        else:
            try:
                user_text = input(console.paint("you> ", "cyan")).strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return
        if not user_text:
            if args.prompt:
                return
            continue
        if user_text.lower() in {"/quit", "/exit"}:
            return
        if user_text.lower() == "/clear":
            history = [{"role": "system", "content": args.system}]
            console.status("CLEARED", "Conversation history cleared", "yellow")
            continue

        history.append({"role": "user", "content": user_text})
        answer = await sample_message(sampling_client, renderer, history, args, console)
        history.append({"role": "assistant", "content": answer})
        print(f"{console.paint('tradefinder>', 'magenta')} {answer}\n")
        if args.prompt:
            return


def main() -> None:
    relaunch_in_project_environment(Path(__file__))
    args = arguments()
    console = Console(disabled=args.no_color)
    try:
        asyncio.run(chat(args, console))
    except (OSError, RuntimeError, ValueError) as exc:
        console.status("ERROR", str(exc), "red")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Download TradeFinder 1 weights and prepare a standalone GGUF model."""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import os
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.request
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
RUN_DIR = ROOT / "runs" / "tradefinder-1"
DEFAULT_CHECKPOINT = (
    "tinker://7613dcda-5329-5a58-a3fb-22709db35383:train:0/"
    "sampler_weights/sampler-step-671"
)
GGUF_REPOSITORY = "unsloth/inkling-GGUF"
GGUF_QUANT = "UD-IQ1_S"
GGUF_EXPECTED_BYTES = 270_160_000_000
MERGE_HEADROOM_BYTES = 20_000_000_000


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("adapter", "gguf", "all"), default="all", nargs="?")
    parser.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, default=RUN_DIR)
    parser.add_argument("--no-color", action="store_true")
    return parser.parse_args()


def format_bytes(value: int) -> str:
    amount = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if amount < 1000 or unit == "TB":
            return f"{amount:,.2f} {unit}"
        amount /= 1000
    raise AssertionError("unreachable")


def safe_extract(archive: Path, output: Path) -> None:
    root = output.resolve()
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        for member in members:
            destination = (output / member.name).resolve()
            if root not in destination.parents and destination != root:
                raise RuntimeError(f"Checkpoint archive contains an unsafe path: {member.name}")
            if member.issym() or member.islnk():
                raise RuntimeError(f"Checkpoint archive contains a link: {member.name}")
        bundle.extractall(output, members=members, filter="data")


def remote_size(url: str) -> int:
    request = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
        return int(response.headers["Content-Length"])


def download_url(url: str, destination: Path, console: Console, workers: int = 32) -> None:
    total = remote_size(url)
    segment_size = (total + workers - 1) // workers
    legacy = destination.with_suffix(destination.suffix + ".part")
    first_segment = destination.with_suffix(destination.suffix + ".part.000")
    if legacy.exists() and legacy.stat().st_size <= segment_size and not first_segment.exists():
        legacy.replace(first_segment)

    part_paths = [
        destination.with_suffix(destination.suffix + f".part.{index:03d}")
        for index in range(workers)
    ]
    progress_lock = threading.Lock()
    downloaded = sum(path.stat().st_size for path in part_paths if path.exists())
    started_at = time.monotonic()

    def fetch(index: int) -> None:
        nonlocal downloaded
        start = index * segment_size
        end = min(total, start + segment_size) - 1
        path = part_paths[index]
        existing = path.stat().st_size if path.exists() else 0
        expected = end - start + 1
        if existing == expected:
            return
        if existing > expected:
            path.unlink()
            existing = 0
        request = urllib.request.Request(
            url, headers={"Range": f"bytes={start + existing}-{end}"}
        )
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            if response.status != 206:
                raise RuntimeError("Checkpoint storage did not honor a ranged download")
            with path.open("ab") as handle:
                while chunk := response.read(8 * 1024 * 1024):
                    handle.write(chunk)
                    with progress_lock:
                        downloaded += len(chunk)
                        console.progress(
                            "ADAPTER",
                            downloaded,
                            total,
                            started_at,
                            f"{format_bytes(downloaded)}  {workers} streams",
                        )
        if path.stat().st_size != expected:
            raise RuntimeError(f"Checkpoint segment {index + 1} is incomplete")

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(fetch, range(workers)))

    temporary = destination.with_suffix(destination.suffix + ".joining")
    with temporary.open("wb") as handle:
        for path in part_paths:
            with path.open("rb") as part:
                shutil.copyfileobj(part, handle, length=8 * 1024 * 1024)
    for path in part_paths:
        path.unlink()
    temporary.replace(destination)


async def download_adapter(
    checkpoint: str, output: Path, raw: dict[str, Any], console: Console
) -> Path:
    adapter_dir = output / "tinker-adapter"
    expected = adapter_dir / "adapter_model.safetensors"
    if expected.exists():
        console.status("ADAPTER", f"Already downloaded at {adapter_dir}", "green")
        return adapter_dir
    if not os.environ.get("TINKER_API_KEY"):
        raise RuntimeError("Set TINKER_API_KEY before downloading the Tinker checkpoint")

    output.mkdir(parents=True, exist_ok=True)
    service_client = await create_tinker_service_client(raw, console)
    rest_client = service_client.create_rest_client()
    response = await await_with_heartbeat(
        asyncio.to_thread(
            lambda: rest_client.get_checkpoint_archive_url_from_tinker_path(checkpoint).result()
        ),
        console,
        "DOWNLOAD",
        "Requesting a signed checkpoint URL",
    )
    archive = output / "tinker-adapter.tar"
    await asyncio.to_thread(download_url, response.url, archive, console)
    adapter_dir.mkdir(parents=True, exist_ok=True)
    console.status("EXTRACT", "Validating and extracting the Tinker adapter")
    await asyncio.to_thread(safe_extract, archive, adapter_dir)
    archive.unlink(missing_ok=True)
    if not expected.exists():
        raise RuntimeError(f"Downloaded checkpoint is missing {expected.name}")
    console.status("ADAPTER", f"Saved to {adapter_dir}", "green")
    return adapter_dir


def first_gguf_shard(base_dir: Path) -> Path:
    shards = sorted(base_dir.glob("*.gguf"))
    if not shards:
        raise RuntimeError(f"No GGUF shards found under {base_dir}")
    return shards[0]


def ensure_free_space(output: Path, required: int) -> None:
    output.mkdir(parents=True, exist_ok=True)
    available = shutil.disk_usage(output).free
    if available < required:
        raise RuntimeError(
            f"GGUF preparation needs about {format_bytes(required)}, but only "
            f"{format_bytes(available)} is free"
        )


def download_base_gguf(output: Path, console: Console) -> Path:
    from huggingface_hub import snapshot_download

    base_dir = output / "inkling-iq1_s"
    if list(base_dir.glob("*.gguf")):
        console.status("BASE", f"Using existing shards in {base_dir}", "green")
        return base_dir
    ensure_free_space(output, GGUF_EXPECTED_BYTES * 2 + MERGE_HEADROOM_BYTES)
    console.status(
        "BASE",
        f"Downloading {GGUF_QUANT} Inkling GGUF, about {format_bytes(GGUF_EXPECTED_BYTES)}",
        "magenta",
    )
    snapshot_download(
        repo_id=GGUF_REPOSITORY,
        allow_patterns=[f"{GGUF_QUANT}/*.gguf"],
        local_dir=output / "base-download",
    )
    source = output / "base-download" / GGUF_QUANT
    if not source.exists():
        raise RuntimeError(f"Hugging Face download did not create {source}")
    source.replace(base_dir)
    shutil.rmtree(output / "base-download", ignore_errors=True)
    console.status("BASE", f"Saved {len(list(base_dir.glob('*.gguf')))} shards", "green")
    return base_dir


def download_inkling_metadata(output: Path, console: Console) -> Path:
    from huggingface_hub import snapshot_download

    metadata = output / "inkling-metadata"
    if (metadata / "config.json").exists():
        return metadata
    console.status("METADATA", "Downloading Inkling config and tokenizer files")
    snapshot_download(
        repo_id="thinkingmachines/Inkling",
        allow_patterns=["*.json", "*.jinja", "*.model", "*.txt"],
        local_dir=metadata,
    )
    return metadata


def run(command: list[str], *, cwd: Path | None = None) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def ensure_llama_cpp(output: Path, console: Console) -> tuple[Path, Path]:
    source = output / "llama.cpp"
    build = source / "build"
    converter = source / "convert_lora_to_gguf.py"
    exporter = build / "bin" / "llama-export-lora"
    if not source.exists():
        console.status("LLAMA.CPP", "Cloning the GGUF conversion tools")
        run(
            [
                "git",
                "clone",
                "--depth",
                "1",
                "https://github.com/ggml-org/llama.cpp.git",
                str(source),
            ]
        )
    if not exporter.exists():
        console.status("LLAMA.CPP", "Building llama-export-lora")
        run(["cmake", "-S", str(source), "-B", str(build), "-DGGML_NATIVE=ON"])
        run(
            [
                "cmake",
                "--build",
                str(build),
                "--config",
                "Release",
                "--target",
                "llama-export-lora",
                "-j",
            ]
        )
    return converter, exporter


def convert_adapter(
    adapter_dir: Path,
    base_metadata: Path,
    output: Path,
    converter: Path,
    console: Console,
) -> Path:
    adapter_gguf = output / "tradefinder-1-lora-f16.gguf"
    if adapter_gguf.exists():
        console.status("LORA", f"Using existing {adapter_gguf.name}", "green")
        return adapter_gguf
    console.status("LORA", "Converting the Tinker LoRA adapter to GGUF")
    run(
        [
            str(ROOT / ".venv" / "bin" / "python"),
            str(converter),
            "--base",
            str(base_metadata),
            "--outfile",
            str(adapter_gguf),
            "--outtype",
            "f16",
            str(adapter_dir),
        ]
    )
    return adapter_gguf


def merge_gguf(
    base_dir: Path, adapter_gguf: Path, output: Path, exporter: Path, console: Console
) -> Path:
    merged = output / "tradefinder-1-inkling-iq1_s.gguf"
    if merged.exists():
        console.status("GGUF", f"Standalone model already exists at {merged}", "green")
        return merged
    base_size = sum(path.stat().st_size for path in base_dir.glob("*.gguf"))
    ensure_free_space(output, base_size + MERGE_HEADROOM_BYTES)
    console.status("MERGE", f"Writing standalone GGUF, about {format_bytes(base_size)}", "magenta")
    run(
        [
            str(exporter),
            "-m",
            str(first_gguf_shard(base_dir)),
            "-o",
            str(merged),
            "--lora",
            str(adapter_gguf),
        ]
    )
    console.status("GGUF", f"Saved standalone model to {merged}", "green")
    return merged


async def execute(args: argparse.Namespace, console: Console) -> None:
    raw = load_config(args.config, console)
    adapter = await download_adapter(args.checkpoint, args.output, raw, console)
    if args.command == "adapter":
        return
    converter, exporter = await asyncio.to_thread(ensure_llama_cpp, args.output, console)
    base_metadata = await asyncio.to_thread(download_inkling_metadata, args.output, console)
    adapter_gguf = await asyncio.to_thread(
        convert_adapter, adapter, base_metadata, args.output, converter, console
    )
    base_dir = await asyncio.to_thread(download_base_gguf, args.output, console)
    await asyncio.to_thread(merge_gguf, base_dir, adapter_gguf, args.output, exporter, console)


def main() -> None:
    relaunch_in_project_environment(Path(__file__))
    args = arguments()
    console = Console(disabled=args.no_color)
    try:
        asyncio.run(execute(args, console))
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        console.status("ERROR", str(exc), "red")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()

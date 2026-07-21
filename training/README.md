# RobinArena Tinker training

This directory downloads daily OHLCV history for the RobinArena universe, derives
past-only market features, creates chronological supervised examples, and runs a
LoRA fine-tune through Tinker. Targets use the same compact decision fields as
`backend/api/openrouter.ts`.

The data builder uses a five-session future return to label buy, sell, and hold
examples. That future value stays in the label-generation path and is never
written into the prompt. The final 10% of market dates form a chronological eval
split. This setup limits look-ahead leakage, though it does not establish that the
resulting policy will trade profitably.

## Setup

Tinker Cookbook currently requires Python 3.11 or newer.

```sh
cd training
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
cp config.example.json config.json
```

Edit `config.json` to change symbols, dates, model, renderer, thresholds, or the
training budget. The default model is the compact Tinker-supported
`Qwen/Qwen3.5-4B`, paired with its non-thinking renderer.

## Prepare the dataset

```sh
python train.py prepare
```

This requests adjustment-aware daily history through yfinance's Yahoo Finance
adapter and caches normalized files in `data/raw`. Generated conversations and a
class/split summary go to `data/processed`. These directories are ignored by Git.
Yahoo data access is suitable for research prototyping; review its terms before
redistributing or using the data commercially.

To rebuild examples from the cached CSV files without network access:

```sh
python train.py prepare --skip-download
```

Inspect `data/processed/summary.json` and sample records before paying for a run.
The examples include two portfolio states per shared market date: a cash portfolio
that can buy or hold, and a portfolio holding the weakest forward-return symbol
that can sell or hold.

## Fine-tune with Tinker

Create an API key in the Tinker Console, then run:

```sh
export TINKER_API_KEY='replace-me'
python train.py train
```

For a low-cost smoke test, set `max_steps` to `2` in `config.json`. The script
creates a LoRA training client, renders each conversation with the model-specific
chat template, trains only on the last assistant response with cross-entropy,
applies Adam updates, and saves resumable state plus sampler weights. Copy the
printed `tinker://` paths into your experiment record.

`python train.py all` prepares fresh data and starts training in one command.
Training is a paid remote operation and the script refuses to start it without
`TINKER_API_KEY`.

## Validate local code

```sh
python -m pytest
python -m ruff check .
```

The Tinker checkpoint is not automatically exposed through OpenRouter. To use the
adapter in the live arena, first deploy or export it through a provider that can
serve the selected base model, then add that provider/model to the backend. Test
the adapter offline and in paper trading before any live-money use.

## References

- [Tinker quick start](https://tinker-docs.thinkingmachines.ai/tinker/quickstart/)
- [First supervised fine-tuning tutorial](https://tinker-docs.thinkingmachines.ai/tutorials/basics/first-sft/)
- [Tinker supervised learning guide](https://tinker-docs.thinkingmachines.ai/cookbook/supervised-learning/)
- [Supported models and pricing](https://tinker-docs.thinkingmachines.ai/tinker/models/)

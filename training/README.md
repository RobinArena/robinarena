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

The model identity is supervised directly: it is **TradeFinder 1, an AI model by
RobinArena**. The identity appears in decision and review system prompts, with
additional identity question-and-answer examples in the training split.

The dataset also contains retrospective review examples. Their input includes a
prior decision, the later symbol return, and the position PnL per $1,000 held.
Targets mark the decision right or wrong, review the inference, and record a
concrete lesson. Correct policy decisions are paired with their outcomes. Clear
losers also produce counterfactual bad buys, while clear winners produce
counterfactual premature sells, so the model sees both verdicts.

Closed production trades add a second review source. The CLI exports the latest
decision and realized-PnL pairs from the Dokploy PostgreSQL container over SSH,
then converts them into review conversations. These examples preserve the
recorded strategy, thesis, rationale, risk note, model, fill prices, return, and
realized PnL. Production CSV files remain local and are ignored by Git.

Review prompts are deliberately separate from live decision prompts. Outcome
dates, future returns, and PnL appear only after the decision window has closed.
The review target preserves factual distinctions: a trailing return can be
reported correctly even when using it to predict continuation or reversal was
wrong.

## Setup

Tinker Cookbook currently requires Python 3.11 or newer.

```sh
cd training
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install -e '.[dev]'
cp config.example.json config.json
```

After setup, `train.py` detects `training/.venv` and relaunches itself with that
Python automatically. Commands wrapped by `nstack env run` therefore work
without manually activating the environment.

Edit `config.json` to change symbols, dates, model, renderer, thresholds, or the
training budget. The default model is `thinkingmachines/Inkling`, paired with
its recommended `tml_v0` renderer. The Inkling dependency extra installs
`tml-renderers` and its compatible Torch version.

## Prepare the dataset

```sh
python train.py prepare
```

This requests adjustment-aware daily history through yfinance's Yahoo Finance
adapter, exports current closed production outcomes, and caches both sources.
Generated conversations and a class/split summary go to `data/processed`. These
directories are ignored by Git.
Yahoo data access is suitable for research prototyping; review its terms before
redistributing or using the data commercially.

To rebuild examples from the cached CSV files without network access:

```sh
python train.py prepare --skip-download
```

Use `--skip-production-sync` only when SSH is unavailable and a cached production
export already exists. Check freshness, source coverage, date bounds, action
counts, and review verdicts at any time:

```sh
python train.py inspect
```

Inspect `data/processed/summary.json` and sample records before paying for a run.
The summary reports decision action counts and right/wrong review counts. Decision
examples include two portfolio states per shared market date: a cash portfolio
that can buy or hold, and a portfolio holding the weakest forward-return symbol
that can sell or hold.

## Fine-tune with Tinker

Create an API key in the Tinker Console, then run:

```sh
export TINKER_API_KEY='replace-me'
python train.py train --dry-run
python train.py train
```

`train` refreshes market data and production outcomes before it renders the
training plan. It prints the exact rendered token count and an estimated cost,
then asks for confirmation before creating a paid Tinker client. `--dry-run`
stops after this preflight. In automation, pass `--yes` to confirm the paid run.
Use `--use-existing-data` only to train an already inspected processed dataset.
Download, dataset-build, rendering, and training progress includes percentage,
elapsed time, throughput, and ETA. Interactive output updates in place while
captured logs receive periodic durable progress lines.
Remote operations emit a heartbeat every 10 seconds while Tinker provisions a
client, processes a batch, applies an optimizer step, or saves a checkpoint.
API requests use a 30-second timeout with two retries by default, avoiding the
SDK's much longer silent retry window. Both values are configurable.
The CLI preserves Tinker's server-provided client flags while forcing its
standard HTTPX transport. This host's certificate chain is accepted by HTTPX
and rejected by the optional pyqwest transport with `UnknownIssuer`.

The checked Inkling training rate is configured as `$5.61` per million tokens,
based on Tinker's published price on 2026-07-22. The estimate covers training
tokens and excludes sampling, storage, taxes, and later price changes. Update the
rate and `pricing_checked_at` in `config.json` when Tinker changes its pricing.

For a low-cost smoke test, set `max_steps` to `2` in `config.json`. The script
trains only on the last assistant response with cross-entropy, applies Adam
updates, and saves resumable state plus sampler weights. Copy the printed
`tinker://` paths into your experiment record.

`python train.py all` remains an alias for a fresh prepare followed by training.
Training is a paid remote operation and requires `TINKER_API_KEY`.

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

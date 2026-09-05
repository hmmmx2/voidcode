"""Steps 3 & 4 — Real training-loop probe with five-stage memory instrumentation.

Runs N full training steps (forward + backward + optimizer.step) and records peak
allocated / reserved memory separately for each of the five failure points:
  load -> optimizer_build -> forward -> backward -> opt_step

Every attempt is wrapped so an OOM is caught, attributed to a stage, and reported
without stopping the remaining attempts.

Usage:
  python 03_probe.py --model Qwen/Qwen2.5-0.5B-Instruct --config adafactor_bf16_gc \
                     --seq 1024 --batch 1 --steps 3 --out results.json
"""
import argparse
import gc
import json
import os
import time
import traceback

import torch

GIB = 1024 ** 3


def gib(x):
    return round(x / GIB, 4)


class Stages:
    """Tracks peak allocated/reserved per stage. Peak is absolute, not delta."""

    def __init__(self):
        self.data = {}
        self.current = None

    def begin(self, name):
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        self.current = name

    def end(self, name):
        torch.cuda.synchronize()
        self.data[name] = dict(
            peak_alloc_gib=gib(torch.cuda.max_memory_allocated()),
            peak_reserved_gib=gib(torch.cuda.max_memory_reserved()),
            resident_alloc_gib=gib(torch.cuda.memory_allocated()),
        )


def build_optimizer(model, config, lr=1e-5):
    if config == "adamw_fp32_bf16mixed":
        return torch.optim.AdamW(model.parameters(), lr=lr)
    if config in ("adamw8bit_gc", "adamw8bit_no_master"):
        import bitsandbytes as bnb
        return bnb.optim.AdamW8bit(model.parameters(), lr=lr)
    if config == "adafactor_bf16_gc":
        from transformers.optimization import Adafactor
        return Adafactor(model.parameters(), lr=lr, scale_parameter=False,
                         relative_step=False, warmup_init=False, beta1=None)
    if config == "galore_r128_8bit_layerwise":
        from galore_torch import GaLoreAdamW8bit
        galore_params, regular = [], []
        for n, p in model.named_parameters():
            if p.dim() == 2 and "embed" not in n and "lm_head" not in n:
                galore_params.append(p)
            else:
                regular.append(p)
        groups = [
            dict(params=regular),
            dict(params=galore_params, rank=128, update_proj_gap=200,
                 scale=0.25, proj_type="std"),
        ]
        return GaLoreAdamW8bit(groups, lr=lr)
    if config == "qlora_nf4_r16":
        # repo baseline: llm/configs/training_config.yaml optim: paged_adamw_32bit
        import bitsandbytes as bnb
        return bnb.optim.PagedAdamW32bit(
            [p for p in model.parameters() if p.requires_grad], lr=lr)
    raise ValueError(f"unknown config {config}")


# model dtype, autocast, gradient checkpointing per config
CONFIG_SPEC = {
    "adamw_fp32_bf16mixed":       dict(dtype=torch.float32,  amp=True,  gc=False),
    "adamw8bit_gc":               dict(dtype=torch.float32,  amp=True,  gc=True),
    "adamw8bit_no_master":        dict(dtype=torch.bfloat16, amp=False, gc=True),
    "adafactor_bf16_gc":          dict(dtype=torch.bfloat16, amp=False, gc=True),
    "galore_r128_8bit_layerwise": dict(dtype=torch.bfloat16, amp=False, gc=True),
    "qlora_nf4_r16":              dict(dtype=torch.bfloat16, amp=False, gc=True),
}


def run(model_id, config, seq, batch, steps):
    from transformers import AutoConfig, AutoModelForCausalLM

    spec = CONFIG_SPEC[config]
    st = Stages()
    result = dict(model=model_id, config=config, seq=seq, batch=batch,
                  steps=steps, ok=False, failed_stage=None, error=None,
                  stages={}, losses=[], step_times=[])

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    total_vram = torch.cuda.get_device_properties(0).total_memory
    result["total_vram_gib"] = gib(total_vram)

    stage = "load"
    try:
        st.begin("load")
        cfg = AutoConfig.from_pretrained(model_id)
        cfg.use_cache = False
        if config == "qlora_nf4_r16":
            from transformers import BitsAndBytesConfig
            from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
            model = AutoModelForCausalLM.from_pretrained(
                model_id, config=cfg, attn_implementation="sdpa",
                quantization_config=BitsAndBytesConfig(
                    load_in_4bit=True, bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=torch.bfloat16,
                    bnb_4bit_use_double_quant=True),
                device_map={"": 0})
            model = prepare_model_for_kbit_training(
                model, use_gradient_checkpointing=True,
                gradient_checkpointing_kwargs={"use_reentrant": False})
            model = get_peft_model(model, LoraConfig(
                r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
                task_type="CAUSAL_LM",
                target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                                "gate_proj", "up_proj", "down_proj"]))
        else:
            model = AutoModelForCausalLM.from_pretrained(
                model_id, config=cfg, dtype=spec["dtype"],
                attn_implementation="sdpa",
            ).to("cuda")
        if spec["gc"]:
            model.gradient_checkpointing_enable(
                gradient_checkpointing_kwargs={"use_reentrant": False})
        model.train()
        st.end("load")
        result["param_count"] = sum(p.numel() for p in model.parameters())

        stage = "optimizer_build"
        st.begin("optimizer_build")
        opt = build_optimizer(model, config)
        st.end("optimizer_build")

        vocab = model.config.vocab_size
        g = torch.Generator(device="cpu").manual_seed(0)
        ids = torch.randint(0, vocab, (batch, seq), generator=g).to("cuda")

        for i in range(steps):
            t0 = time.perf_counter()

            stage = "forward"
            st.begin("forward")
            if spec["amp"]:
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    out = model(input_ids=ids, labels=ids)
            else:
                out = model(input_ids=ids, labels=ids)
            loss = out.loss
            st.end("forward")

            stage = "backward"
            st.begin("backward")
            loss.backward()
            st.end("backward")

            stage = "opt_step"
            st.begin("opt_step")
            opt.step()
            st.end("opt_step")

            result["step_times"].append(time.perf_counter() - t0)
            result["losses"].append(float(loss.detach()))

            # Static state == weights + grads + optimizer states ONLY.
            # The logits tensor inside `out` must be released first or it inflates
            # the figure by batch*seq*vocab bytes and corrupts the estimator check.
            del out, loss
            gc.collect()
            torch.cuda.synchronize()
            result["static_state_gib"] = gib(torch.cuda.memory_allocated())

            # set_to_none=False keeps the grad buffers RESIDENT, which is what
            # gradient_accumulation_steps=32 (the repo's setting) actually does.
            # set_to_none=True would free them and understate the real peak.
            opt.zero_grad(set_to_none=False)
            torch.cuda.synchronize()
            result["weights_plus_opt_gib"] = gib(torch.cuda.memory_allocated())

        result["ok"] = True
        result["stages"] = st.data
        # NOTE: peak stats are reset per stage, so max_memory_allocated() at the end
        # only reflects the LAST stage. The true peak is the max across stages.
        result["peak_alloc_gib"] = max(s["peak_alloc_gib"] for s in st.data.values())
        result["peak_reserved_gib"] = max(s["peak_reserved_gib"] for s in st.data.values())
        result["peak_stage"] = max(st.data, key=lambda k: st.data[k]["peak_alloc_gib"])
        result["activation_gib"] = round(
            result["peak_alloc_gib"] - result["static_state_gib"], 4)
        free, _ = torch.cuda.mem_get_info()
        result["free_vram_at_end_gib"] = gib(free)
        # throughput over the tail steps only, warm-up excluded
        tail = result["step_times"][2:] or result["step_times"][-1:]
        result["tokens_per_sec"] = round(batch * seq / (sum(tail) / len(tail)), 1)

    except torch.cuda.OutOfMemoryError as e:
        result["failed_stage"] = stage
        result["error"] = "CUDA_OOM: " + str(e).split("\n")[0][:300]
        result["stages"] = st.data
        if st.data:
            result["peak_alloc_gib"] = max(s["peak_alloc_gib"] for s in st.data.values())
            result["peak_reserved_gib"] = max(s["peak_reserved_gib"] for s in st.data.values())
    except Exception as e:  # noqa: BLE001
        result["failed_stage"] = stage
        result["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        result["traceback"] = traceback.format_exc()[-800:]
        result["stages"] = st.data

    for name in ("model", "opt", "ids"):
        if name in dir():
            pass
    try:
        del model, opt, ids
    except Exception:
        pass
    gc.collect()
    torch.cuda.empty_cache()
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--seq", type=int, default=1024)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--steps", type=int, default=3)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    r = run(a.model, a.config, a.seq, a.batch, a.steps)
    print(json.dumps(r, indent=2))
    if a.out:
        with open(a.out, "a") as f:
            f.write(json.dumps(r) + "\n")

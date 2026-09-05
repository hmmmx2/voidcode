"""Measure ACTIVATION memory of the exact target architecture, decomposed.

The 7.6B model does not fit on this machine, so activations are measured in two
separable pieces that each do fit, then recomposed:

  (a) per-layer term  - real hidden/intermediate/head geometry, TINY vocab.
                        Sweep num_hidden_layers; the slope is GiB per layer.
  (b) logits/head term- real vocab (152064), TINY hidden. Logits are [b, s, V],
                        so their memory is independent of hidden_size; shrinking
                        hidden isolates the loss-head cost without distortion.

  A(L, s) = L * per_layer(s) + head(s)

No optimizer is constructed: activations do not depend on optimizer state.
static == weights + grads only, so activation == peak(backward) - static.
"""
import argparse
import gc
import json
import traceback

import torch
from transformers import Qwen2Config, AutoConfig, AutoModelForCausalLM

GIB = 1024 ** 3


def gib(x):
    return round(x / GIB, 4)


def run(hidden, inter, layers, heads, kv, vocab, seq, batch, grad_ckpt,
        pretrained=None):
    r = dict(hidden=hidden, inter=inter, layers=layers, heads=heads, kv=kv,
             vocab=vocab, seq=seq, batch=batch, grad_ckpt=grad_ckpt,
             pretrained=pretrained, ok=False)
    try:
        torch.cuda.empty_cache()
        if pretrained:
            # identical measurement path, real checkpoint - isolates harness
            # differences from architecture differences
            cfg = AutoConfig.from_pretrained(pretrained)
            cfg.use_cache = False
            model = AutoModelForCausalLM.from_pretrained(
                pretrained, config=cfg, dtype=torch.bfloat16,
                attn_implementation="sdpa").to("cuda")
            vocab = cfg.vocab_size
            r.update(hidden=cfg.hidden_size, inter=cfg.intermediate_size,
                     layers=cfg.num_hidden_layers, vocab=vocab)
        else:
            cfg = Qwen2Config(
                hidden_size=hidden, intermediate_size=inter,
                num_hidden_layers=layers, num_attention_heads=heads,
                num_key_value_heads=kv, vocab_size=vocab,
                max_position_embeddings=32768, rope_theta=1000000.0,
                rms_norm_eps=1e-6, tie_word_embeddings=False, use_cache=False,
            )
            model = AutoModelForCausalLM.from_config(
                cfg, attn_implementation="sdpa").to("cuda", torch.bfloat16)
        if grad_ckpt:
            model.gradient_checkpointing_enable(
                gradient_checkpointing_kwargs={"use_reentrant": False})
        model.train()
        r["param_count"] = sum(p.numel() for p in model.parameters())

        ids = torch.randint(0, vocab, (batch, seq),
                            generator=torch.Generator().manual_seed(0)).to("cuda")

        # one warm-up step so allocator pools and grads already exist
        out = model(input_ids=ids, labels=ids)
        out.loss.backward()
        del out
        gc.collect()
        torch.cuda.synchronize()
        static = torch.cuda.memory_allocated()
        r["static_gib"] = gib(static)

        torch.cuda.reset_peak_memory_stats()
        out = model(input_ids=ids, labels=ids)
        loss = out.loss
        r["peak_forward_gib"] = gib(torch.cuda.max_memory_allocated())
        loss.backward()
        torch.cuda.synchronize()
        peak = torch.cuda.max_memory_allocated()
        r["peak_gib"] = gib(peak)
        r["activation_gib"] = gib(peak - static)
        r["loss"] = float(loss.detach())
        r["ok"] = True
        del out, loss, model, ids
    except torch.cuda.OutOfMemoryError as e:
        r["error"] = "CUDA_OOM: " + str(e).split("\n")[0][:200]
    except Exception as e:  # noqa: BLE001
        r["error"] = f"{type(e).__name__}: {str(e)[:200]}"
        r["traceback"] = traceback.format_exc()[-500:]
    gc.collect()
    torch.cuda.empty_cache()
    return r


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    for k, d in [("hidden", 3584), ("inter", 18944), ("layers", 4), ("heads", 28),
                 ("kv", 4), ("vocab", 152064), ("seq", 1024), ("batch", 1)]:
        ap.add_argument(f"--{k}", type=int, default=d)
    ap.add_argument("--no-gc", action="store_true")
    ap.add_argument("--pretrained", default=None)
    ap.add_argument("--out")
    a = ap.parse_args()
    res = run(a.hidden, a.inter, a.layers, a.heads, a.kv, a.vocab, a.seq,
              a.batch, not a.no_gc, a.pretrained)
    print(json.dumps(res))
    if a.out:
        with open(a.out, "a") as f:
            f.write(json.dumps(res) + "\n")

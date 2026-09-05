"""Step 1 — Resolve the exact parameter count on the meta device (allocates nothing)."""
import sys
from transformers import AutoConfig, AutoModelForCausalLM
from accelerate import init_empty_weights

MODEL_ID = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-7B-Instruct"

cfg = AutoConfig.from_pretrained(MODEL_ID)
with init_empty_weights():
    m = AutoModelForCausalLM.from_config(cfg)

total = sum(p.numel() for p in m.parameters())
trainable = sum(p.numel() for p in m.parameters() if p.requires_grad)
embed = sum(p.numel() for n, p in m.named_parameters() if "embed" in n or "lm_head" in n)

print(f"model_id           {MODEL_ID}")
print(f"total_params       {total:,}")
print(f"trainable_params   {trainable:,}")
print(f"embedding_params   {embed:,}")
print(f"non_embed_params   {total - embed:,}")
print(f"tie_word_embeddings{'':2}{cfg.tie_word_embeddings}")
print(f"hidden_size        {cfg.hidden_size}")
print(f"num_hidden_layers  {cfg.num_hidden_layers}")
print(f"num_attn_heads     {cfg.num_attention_heads}")
print(f"num_kv_heads       {cfg.num_key_value_heads}")
print(f"intermediate_size  {cfg.intermediate_size}")
print(f"vocab_size         {cfg.vocab_size}")
print(f"max_position_emb   {cfg.max_position_embeddings}")

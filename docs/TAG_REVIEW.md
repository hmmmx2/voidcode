# Concept tag review

**GENERATED — do not edit by hand.** Run `python scripts/tag_review.py --write`.
The review state lives in the YAML: set `review_needed: false` on an item to mark it done.
A previous hand-written version of this file went stale the day two items were added.

**57 decisions pending**, covering 94 items. They are not all the same kind of work.

- **54 keyword-inferred.** Tagged by matching the slug and title during migration, never
  confirmed by anyone. The bulk of the list.
- **3 authored-then-flagged.** Tagged deliberately, then marked for review. Their tags
  are probably fine; what wants checking is the *content*.

**37 interview-table copies are folded into their originals.** Every `iq-<slug>` carries concepts identical to `<slug>`, so listing both would ask for the same decision twice.

## Why this matters more than it looks

These tags write into `problem_concepts` and feed mastery attribution. Credit for a submission is
divided across an item's concepts, so a wrong tag does not add noise — it moves weight from one
concept to another. The ranker then recommends against a weakness the learner does not have, and
the failure is invisible, because the numbers look healthy and are simply about the wrong thing.

## How to review efficiently

**Grouped by concept, because that is the view where a mis-grouping is obvious.** Scan each block
and ask one question: *would a learner weak at this concept be well served by these problems?*
If yes, the block is fine. If one item looks out of place, it is.

Start with the blocks holding a single item — one item is the least evidence that a tag is right,
and a lone mis-tag is the easiest to miss.

## How to fix one

Edit `content/problems/<slug>.yaml`, correct `concepts:`, set `review_needed: false`.
Concept ids must exist in `data/concepts.yaml`; the loader rejects a typo, so a mistake fails
loudly rather than silently dropping the item out of ranking.

Editing an item with a twin? Change both — `scripts/tag_review.py` reports a pair whose tags have
diverged as a defect, since the same content tagged two ways splits one learner's evidence across
two concepts.

Verify: `python -m pytest tests -q`

---


## `attention_scaled_dot`  (6)

- [ ] **attention-is-all-you-need** — Attention Is All You Need
- [ ] **attention-vs-ffn-crossover** — Find the length where attention FLOPs overtake everything else  _also: feedforward_blocks_  _+ iq-attention-vs-ffn-crossover_
- [ ] **flashattention** — FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness  _also: flash_attention_
- [ ] **scaled-dot-product-attention** — Scaled Dot-Product Attention
- [ ] **vit-token-budget** — Token count and attention cost across two ViT configurations  _also: tokenization, vision_transformer_  _+ iq-vit-token-budget_
- [ ] **why-scale-by-sqrt-dk** — Size the attention score divisor from head width  _+ iq-why-scale-by-sqrt-dk_

## `backpropagation`  (5)

- [ ] **derive-layernorm-backward** — Push a gradient back through LayerNorm  _also: normalization_layers_  _+ iq-derive-layernorm-backward_
- [ ] **derive-logistic-gradient** — Gradient of the logistic log-loss  _also: loss_functions_  _+ iq-derive-logistic-gradient_
- [ ] **implement-grad-clip** — Global-norm gradient clipping  _also: normalization_layers_  _+ iq-implement-grad-clip_
- [ ] **matrix-calculus-backprop** — Backprop a linear layer by hand  _also: linear_layers_  _+ iq-matrix-calculus-backprop_
- [ ] **residual-jacobian** — Decompose a residual stack's gradient by path length  _+ iq-residual-jacobian_

## `embeddings`  (3)

- [ ] **interpolate-pos-embed** — Resize a ViT's position embeddings  _also: vision_transformer, image_preprocessing_  _+ iq-interpolate-pos-embed_
- [ ] **modality-gap-invariance** — Measure the offset between two encoders' embedding clouds  _also: projection_layers_  _+ iq-modality-gap-invariance_
- [ ] **patch-embedding-cost** — Share of a ViT spent in the patch stem  _also: vision_transformer_  _+ iq-patch-embedding-cost_

## `feedforward_blocks`  (1)

- [ ] **attention-vs-ffn-crossover** — Find the length where attention FLOPs overtake everything else  _also: attention_scaled_dot_  _+ iq-attention-vs-ffn-crossover_

## `flash_attention`  (1)

- [ ] **flashattention** — FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness  _also: attention_scaled_dot_

## `gpu_execution_model`  (1)

- [ ] **thread-index-mapping** — Thread Index Mapping

## `image_preprocessing`  (3)

- [ ] **implement-iou-batch** — Write vectorised IoU
- [ ] **interpolate-pos-embed** — Resize a ViT's position embeddings  _also: embeddings, vision_transformer_  _+ iq-interpolate-pos-embed_
- [ ] **iou-nms** — IoU and Non-Max Suppression

## `kv_cache`  (1)

- [ ] **kv-cache-memory** — Size the KV cache and count concurrent requests  _+ iq-kv-cache-memory_

## `linear_layers`  (2)

- [ ] **count-transformer-params** — Count the parameters of a transformer config  _+ iq-count-transformer-params_
- [ ] **matrix-calculus-backprop** — Backprop a linear layer by hand  _also: backpropagation_  _+ iq-matrix-calculus-backprop_

## `loss_functions`  (9)

- [ ] **bayes-optimal-threshold** — Threshold a calibrated score by cost  _+ iq-bayes-optimal-threshold_
- [ ] **cross-entropy-loss** — Cross-Entropy Loss
- [ ] **dead-group-rate-grpo** — Count the GRPO groups that carry no gradient  _also: rlhf_grpo_
- [ ] **derive-infonce** — Symmetric contrastive loss for an image-text batch  _+ iq-derive-infonce_
- [ ] **derive-logistic-gradient** — Gradient of the logistic log-loss  _also: backpropagation_  _+ iq-derive-logistic-gradient_
- [ ] **implement-auc** — Compute ROC-AUC on a whiteboard  _+ iq-implement-auc_
- [ ] **kl-divergence-asymmetry** — Compute both directions of KL with the zero cases right  _+ iq-kl-divergence-asymmetry_
- [ ] **perplexity-and-loss** — Turn log-likelihoods into perplexity and bits-per-byte  _also: sampling_decoding_  _+ iq-perplexity-and-loss_
- [ ] **why-cross-entropy-not-mse** — Return dL/dz for softmax under two losses  _also: numerical_stability_  _+ iq-why-cross-entropy-not-mse_

## `lr_scheduling`  (1)

- [ ] **warmup-adam-variance** — Compute the effective sample count behind Adam's second moment  _also: optimizers_adaptive_  _+ iq-warmup-adam-variance_

## `memory_accounting`  (3)

- [ ] **activation-memory-budget** — Size a mixed-precision training memory budget  _also: mixed_precision_  _+ iq-activation-memory-budget_
- [ ] **optimizer-moment-dtype-trap** — Why did the bf16 run use less memory than it should have?  _also: mixed_precision_
- [ ] **zero-stage-memory-arithmetic** — Which ZeRO stage does this model need?  _also: zero_sharding_

## `memory_coalescing`  (1)

- [ ] **coalescing-transaction-count** — Count the sectors a warp actually fetches  _also: warp_divergence_  _+ iq-coalescing-transaction-count_

## `mixed_precision`  (3)

- [ ] **activation-memory-budget** — Size a mixed-precision training memory budget  _also: memory_accounting_  _+ iq-activation-memory-budget_
- [ ] **fp16-update-underflow** — Simulate a weight update in a low-precision format  _+ iq-fp16-update-underflow_
- [ ] **optimizer-moment-dtype-trap** — Why did the bf16 run use less memory than it should have?  _also: memory_accounting_

## `normalization_layers`  (4)

- [ ] **batchnorm-inference** — BatchNorm at Inference
- [ ] **derive-layernorm-backward** — Push a gradient back through LayerNorm  _also: backpropagation_  _+ iq-derive-layernorm-backward_
- [ ] **implement-grad-clip** — Global-norm gradient clipping  _also: backpropagation_  _+ iq-implement-grad-clip_
- [ ] **layer-norm** — Layer Normalisation

## `numerical_stability`  (4)

- [ ] **implement-causal-mask** — Softmax over a row that is entirely masked  _+ iq-implement-causal-mask_
- [ ] **logsumexp-stability** — Merge log-sum-exp across tiles seen one at a time  _+ iq-logsumexp-stability_
- [ ] **stable-softmax** — Numerically Stable Softmax
- [ ] **why-cross-entropy-not-mse** — Return dL/dz for softmax under two losses  _also: loss_functions_  _+ iq-why-cross-entropy-not-mse_

## `occupancy`  (1)

- [ ] **occupancy-from-resources** — Compute occupancy from the binding resource  _+ iq-occupancy-from-resources_

## `optimizers_adaptive`  (2)

- [ ] **implement-adam-update** — Write the Adam update  _+ iq-implement-adam-update_
- [ ] **warmup-adam-variance** — Compute the effective sample count behind Adam's second moment  _also: lr_scheduling_  _+ iq-warmup-adam-variance_

## `optimizers_sgd`  (1)

- [ ] **sgd-momentum-step** — SGD Step with Momentum

## `pipeline_parallel`  (1)

- [ ] **pipeline-bubble-fraction** — Compute the pipeline bubble and the micro-batch count it demands  _+ iq-pipeline-bubble-fraction_

## `positional_encoding`  (1)

- [ ] **derive-rope-relative** — Rotate q and k by position, then dot them  _+ iq-derive-rope-relative_

## `projection_layers`  (1)

- [ ] **modality-gap-invariance** — Measure the offset between two encoders' embedding clouds  _also: embeddings_  _+ iq-modality-gap-invariance_

## `reduction_kernels`  (2)

- [ ] **implement-warp-reduction** — Simulate a warp shuffle reduction  _also: warp_divergence_  _+ iq-implement-warp-reduction_
- [ ] **parallel-reduction** — Parallel Reduction

## `regularization`  (1)

- [ ] **expectation-of-dropout** — Compute the moments inverted dropout leaves behind  _+ iq-expectation-of-dropout_

## `rlhf_grpo`  (1)

- [ ] **dead-group-rate-grpo** — Count the GRPO groups that carry no gradient  _also: loss_functions_

## `roofline_analysis`  (1)

- [ ] **arithmetic-intensity-roofline** — Place a kernel on the roofline  _+ iq-arithmetic-intensity-roofline_

## `sampling_decoding`  (4)

- [ ] **decode-throughput-arithmetic** — Bound decode throughput from memory bandwidth  _+ iq-decode-throughput-arithmetic_
- [ ] **implement-top-p** — Write nucleus sampling
- [ ] **perplexity-and-loss** — Turn log-likelihoods into perplexity and bits-per-byte  _also: loss_functions_  _+ iq-perplexity-and-loss_
- [ ] **top-p-sampling** — Nucleus (Top-p) Filtering

## `tensors_and_shapes`  (5)

- [ ] **bias-variance-decomposition** — Split test error into bias, variance and noise  _+ iq-bias-variance-decomposition_
- [ ] **broadcast-shapes** — Broadcasting Shapes
- [ ] **eigenvalues-of-the-hessian** — Score a learning rate against the curvature spectrum  _+ iq-eigenvalues-of-the-hessian_
- [ ] **implement-stratified-split** — Split without leaking a user across the boundary  _+ iq-implement-stratified-split_
- [ ] **resampling-odds-correction** — Undo resampling with an odds correction  _+ iq-resampling-odds-correction_

## `tokenization`  (3)

- [ ] **bpe-merge** — Byte-Pair Encoding Merge
- [ ] **subword-units-bpe** — Neural Machine Translation of Rare Words with Subword Units
- [ ] **vit-token-budget** — Token count and attention cost across two ViT configurations  _also: attention_scaled_dot, vision_transformer_  _+ iq-vit-token-budget_

## `vision_transformer`  (3)

- [ ] **interpolate-pos-embed** — Resize a ViT's position embeddings  _also: embeddings, image_preprocessing_  _+ iq-interpolate-pos-embed_
- [ ] **patch-embedding-cost** — Share of a ViT spent in the patch stem  _also: embeddings_  _+ iq-patch-embedding-cost_
- [ ] **vit-token-budget** — Token count and attention cost across two ViT configurations  _also: attention_scaled_dot, tokenization_  _+ iq-vit-token-budget_

## `warp_divergence`  (2)

- [ ] **coalescing-transaction-count** — Count the sectors a warp actually fetches  _also: memory_coalescing_  _+ iq-coalescing-transaction-count_
- [ ] **implement-warp-reduction** — Simulate a warp shuffle reduction  _also: reduction_kernels_  _+ iq-implement-warp-reduction_

## `zero_sharding`  (1)

- [ ] **zero-stage-memory-arithmetic** — Which ZeRO stage does this model need?  _also: memory_accounting_

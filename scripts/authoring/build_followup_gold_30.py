"""Extend the followup gold set from 4 scenarios to 30.

WHY 30, AND WHY THIS SET CANNOT SETTLE EVERYTHING
--------------------------------------------------
At n=4 the mode had no measurable rate: across nine runs its all-checks score was 0, 1, 2 and 3 of 4
— nearly the whole scale. Every point estimate reported for it was an arm-specific draw. Thirty
scenarios make a rate meaningful.

**They do not make it valid.** These are authored by the same agent that tuned the router, the
prompts and the scorer, so they inherit assumptions about what a followup looks like. `docs/
READINESS.md` Phase 5 calls for scenarios neither the harness author nor the prompt author wrote;
this set is a fix for the statistical problem only, and the validity problem stays open.

WHAT MAKES A FOLLOWUP SCENARIO VALID
-------------------------------------
Three properties, each learned from a defect found in the original four:

1. **The back-reference must resolve.** The learner says "you said X" and the assistant must
   actually have said X. Without it the model invents context or refuses — one of the original four
   refused with "we've shifted topics away from our current discussion on LLM inference batching".

2. **The prior turn must not contain the answer.** If the authored context already states the
   required keyword, the model passes by copying and the mode looks fine while testing nothing.

3. **Required keywords must not appear in the learner's own question.** Two of the original four
   required a keyword the learner had already used, so it was satisfied by echoing — and worse, it
   padded `covered` so a total miss on substance read as partial credit.

All three are asserted before writing, and the script REFUSES rather than warns. Two of these guards
caught mistakes in my own authoring while writing this file.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOLD = ROOT / "llm" / "data" / "eval_followup_gold.jsonl"

#: (id, difficulty, prior_user, prior_assistant, followup_question, must_mention, notes)
#:
#: The prior assistant turn raises the topic and stops at the point the learner asks about. The
#: keywords are the MECHANISM, chosen so they appear in neither the question nor the prior turns.
NEW = [
    ("followup_grad_clipping_002", "medium",
     "My loss suddenly jumps to NaN partway through training.",
     "That pattern usually points at a small number of very large updates rather than a steady "
     "problem. Most training loops add a safeguard for exactly this. Do you have one?",
     "You mentioned a safeguard for huge updates. How does clipping actually work?",
     ["norm", "threshold"],
     "Rescales the gradient when its norm exceeds a threshold, preserving direction."),

    ("followup_weight_decay_003", "medium",
     "Should I use weight decay or L2 regularisation in my optimizer?",
     "People often treat them as the same thing, and with plain SGD they coincide. With Adam they "
     "do not. Do you know which optimizer you are using?",
     "You said they differ under Adam. Why exactly?",
     ["adaptive", "decoupl"],
     "Adam's adaptive scaling distorts an L2 penalty; AdamW decouples the decay."),

    ("followup_layernorm_004", "medium",
     "Why do transformers use layer norm rather than the batch version?",
     "It comes down to what each one normalises over, and that changes how the model behaves at "
     "different batch sizes. What follows from that?",
     "Following on from that — what breaks if I use the batch version in a transformer?",
     ["depend", "inference"],
     "Batch statistics couple examples and break with variable sequence lengths and batch size 1."),

    ("followup_attention_mask_005", "hard",
     "My decoder seems to be cheating during training — the loss is far too low.",
     "That is a classic symptom with a specific cause in how attention is set up for generation "
     "tasks. What is attention allowed to look at in your model?",
     "You hinted at what attention can see. What am I missing?",
     ["causal", "future"],
     "A causal mask is required so positions cannot attend to future tokens."),

    ("followup_positional_006", "medium",
     "Does a transformer know what order my tokens are in?",
     "Not on its own — self-attention is permutation invariant, so order has to be supplied some "
     "other way. How do you think that is usually done?",
     "You said order has to be supplied. How?",
     ["encod", "position"],
     "Positional encodings are added to embeddings, learned or sinusoidal."),

    ("followup_cosine_schedule_007", "easy",
     "Is a constant learning rate fine for fine-tuning?",
     "It works, but most recipes decay it over training, and the shape of that decay matters more "
     "than people expect. Have you looked at the schedules on offer?",
     "Earlier you mentioned decay shape. Why is cosine so common?",
     ["smooth", "anneal"],
     "Smooth annealing to near zero, no abrupt drops, no extra hyperparameters."),

    ("followup_loss_scaling_008", "hard",
     "I switched to fp16 and now my gradients are all zero.",
     "That is expected rather than a bug — half precision has a much smaller representable range "
     "than fp32, and small values fall off the bottom of it. What do you think happens to a "
     "gradient of 1e-8?",
     "You said small values fall off the bottom. How do people work around it?",
     ["scal", "underflow"],
     "Loss scaling multiplies the loss before backward so gradients avoid underflow."),

    ("followup_grad_checkpoint_009", "hard",
     "I am out of GPU memory but I cannot reduce the batch size any further.",
     "There is a trade you can make: spend extra compute to avoid storing something. Do you know "
     "what dominates activation memory in a deep network?",
     "Following on from that — what does checkpointing trade away?",
     ["recomput", "forward"],
     "Discards intermediate activations and recomputes them during backward."),

    ("followup_kv_cache_010", "medium",
     "Generation gets slower the longer my output becomes.",
     "It should not, if the implementation is doing the right thing. Think about what the model "
     "recomputes on every new token. What is unnecessary there?",
     "You said something is recomputed unnecessarily. What is stored instead?",
     ["key", "value"],
     "Past keys and values are cached so only the new token is processed."),

    ("followup_beam_vs_sample_011", "medium",
     "My summaries are accurate but read like they were written by a committee.",
     "That is a known signature of one particular decoding strategy. How are you choosing the next "
     "token at generation time?",
     "You mentioned decoding strategy. Why does beam search sound so flat?",
     ["likelihood", "divers"],
     "Beam search maximises likelihood, which favours generic high-probability phrasing."),

    ("followup_top_p_012", "easy",
     "What is the difference between temperature and top-p?",
     "They both change how adventurous generation is, but they act at different points in the "
     "process — one reshapes the distribution, the other truncates it. Which are you tuning?",
     "You said one truncates. How does top-p decide where to cut?",
     ["cumulative", "mass"],
     "Keeps the smallest set of tokens whose cumulative probability mass exceeds p."),

    ("followup_early_stopping_013", "easy",
     "How do I know when to stop training?",
     "The usual approach watches a held-out signal rather than the training loss, and stops when "
     "that signal stops improving. Which split are you monitoring?",
     "Earlier you mentioned a held-out signal. What goes wrong if I use the test set for it?",
     ["leak", "optimistic"],
     "Selecting on the test set leaks it into the decision and biases the estimate."),

    ("followup_class_imbalance_014", "medium",
     "My classifier reports 97% accuracy but is useless in practice.",
     "With a rare positive class that number can be achieved by a model that never predicts it at "
     "all. What fraction of your data is the positive class?",
     "You said accuracy can hide that. What should I look at instead?",
     ["recall", "precision"],
     "Precision and recall on the minority class, or a PR curve."),

    ("followup_data_leakage_015", "hard",
     "My validation score is excellent and production performance is terrible.",
     "That gap almost always means the validation set saw something it should not have. How did you "
     "build your splits?",
     "You said the split may have seen something. What kind of thing?",
     ["future", "target"],
     "Features computed after the target, or rows sharing an entity across splits."),

    ("followup_cross_val_016", "medium",
     "Is a single train/test split enough to trust my numbers?",
     "It gives you a single number with no sense of how much it would move on a different split. "
     "There is a standard way of getting that spread. Do you know it?",
     "Following on from that — what does k-fold actually buy me?",
     ["varian", "estimate"],
     "Multiple estimates give a variance, not just a point value."),

    ("followup_feature_scaling_017", "easy",
     "Does it matter that my features are on wildly different scales?",
     "For some models it is irrelevant and for others it dominates the result. Which model family "
     "are you using?",
     "You said it dominates for some models. Which ones, and why?",
     ["distance", "gradient"],
     "Distance-based and gradient-based methods are scale sensitive; trees are not."),

    ("followup_embeddings_018", "medium",
     "Why not just one-hot encode my vocabulary?",
     "You can, but it gets impractical quickly and it throws away something a learned "
     "representation keeps. What does one-hot say about the relationship between two words?",
     "You said one-hot throws something away. What do embeddings keep?",
     ["similar", "dens"],
     "A dense space where similar tokens sit near one another."),

    ("followup_residual_019", "medium",
     "My 50-layer network trains worse than my 10-layer one.",
     "Depth alone does not help unless the signal can travel back through all of it. What happens "
     "to a gradient as it passes through many layers?",
     "You mentioned the signal travelling back. How do residual connections help?",
     ["identity", "path"],
     "An identity path lets gradients bypass layers, so depth does not attenuate them."),

    ("followup_adam_vs_sgd_020", "medium",
     "Everyone uses Adam. Is there a reason to pick SGD?",
     "Adam converges faster in wall-clock terms, but the two often end up in different kinds of "
     "solution, and that shows up at test time rather than during training. Have you compared them?",
     "You said they land in different solutions. What is the practical difference?",
     ["generali", "momentum"],
     "SGD with momentum often generalises better; Adam adapts per-parameter and can overfit sharper minima."),

    ("followup_label_smoothing_021", "hard",
     "My model is confidently wrong on examples it has never seen.",
     "Overconfidence like that usually comes from the training objective rewarding certainty "
     "without bound. What target does your loss push each prediction towards?",
     "You said the target pushes towards certainty. What does smoothing change?",
     ["soft", "calibrat"],
     "Soft targets prevent unbounded logit growth and improve calibration."),

    ("followup_quantization_022", "medium",
     "Can I shrink my model without retraining it?",
     "Usually yes — you can reduce the precision of the stored weights after the fact, with a "
     "quality cost that depends on how far you go. How small are you trying to get?",
     "Following on from that — what actually degrades when I go to 4 bits?",
     ["outlier", "range"],
     "Outlier weights dominate the range, so fine detail is lost at low bit widths."),

    ("followup_lora_023", "medium",
     "Fine-tuning the whole model is too expensive for my hardware.",
     "There are methods that train a small fraction of the parameters and leave the rest frozen. "
     "Have you looked at any of them?",
     "You mentioned training a small fraction. How does LoRA choose which?",
     ["low-rank", "adapter"],
     "Low-rank adapter matrices are injected and trained while base weights stay frozen."),

    ("followup_distillation_024", "hard",
     "I need my model to run on a phone but accuracy drops when I shrink it.",
     "Training a small model directly is not the only option — it can instead learn from a larger "
     "one that has already solved the task. What could the small model learn beyond the labels?",
     "You said it learns beyond the labels. What exactly?",
     ["soft", "teacher"],
     "The teacher's soft output distribution carries relative class information the hard label omits."),

    ("followup_rag_chunking_025", "medium",
     "My retrieval returns documents that are technically related but useless.",
     "That often traces back to how the corpus was split before it was embedded, rather than to the "
     "retriever itself. How large are your chunks?",
     "You said the split matters. What goes wrong with chunks that are too large?",
     ["dilut", "granular"],
     "A large chunk's embedding averages several topics, diluting the match."),

    ("followup_perplexity_026", "hard",
     "My language model's perplexity improved but the outputs seem no better.",
     "Perplexity measures one specific thing, and it is not the same as whether a human finds the "
     "output useful. What is it actually computing?",
     "You said it measures one specific thing. What is it, and what does it miss?",
     ["predict", "coheren"],
     "It scores next-token prediction on held-out text, not factuality or long-range coherence."),

    ("followup_roc_vs_pr_027", "hard",
     "My ROC AUC is 0.95 but the model is useless on my rare-event problem.",
     "ROC can look strong when positives are rare, because of what it puts on each axis. What "
     "fraction of your labels are positive?",
     "You said the axes matter. Which curve should I use instead?",
     ["precision", "imbalanc"],
     "Precision-recall is sensitive to the positive rate; ROC's false-positive rate is not."),
]


def build(entry: dict) -> dict:
    sid, difficulty, prior_u, prior_a, question, keywords, notes = entry
    return {
        "id": sid,
        "difficulty": difficulty,
        "user_message": question,
        "must_mention": list(keywords),
        "notes": notes,
        "mode": "followup",
        "messages": [
            {"role": "user", "content": prior_u},
            {"role": "assistant", "content": prior_a},
            {"role": "user", "content": question},
        ],
    }


def validate(row: dict) -> list[str]:
    """The three properties, each learned from a defect in the original four."""
    problems = []
    question = row["user_message"].lower()
    prior = " ".join(m["content"] for m in row["messages"][:-1]).lower()
    assistant = " ".join(m["content"] for m in row["messages"] if m["role"] == "assistant").lower()

    if not any(m["role"] == "assistant" for m in row["messages"][:-1]):
        problems.append("no prior assistant turn — the back-reference has no referent")
    for kw in row["must_mention"]:
        if kw.lower() in question:
            problems.append(f"keyword {kw!r} is echoable from the learner's own question")
        if kw.lower() in assistant:
            problems.append(f"keyword {kw!r} is already stated in the prior assistant turn")
    if not row["must_mention"]:
        problems.append("no required keywords — the check would pass vacuously")
    if len(prior.split()) < 15:
        problems.append("prior context too thin to make the reference resolvable")
    return problems


def main() -> int:
    existing = [json.loads(line) for line in GOLD.read_text(encoding="utf-8").splitlines()
                if line.strip()]
    have = {r["id"] for r in existing}

    built, failed = [], 0
    for entry in NEW:
        row = build(entry)
        if row["id"] in have:
            print(f"  {row['id']}: already present, skipped")
            continue
        problems = validate(row)
        if problems:
            failed += 1
            print(f"  !! {row['id']}:")
            for p in problems:
                print(f"       {p}")
            continue
        built.append(row)

    if failed:
        print(f"\n  REFUSING to write: {failed} scenario(s) failed validation. "
              "A scenario that fails these tests measures something other than the mode.")
        return 1

    rows = existing + built
    GOLD.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                    encoding="utf-8")
    print(f"  validated and wrote {len(built)} new scenario(s); {len(rows)} total")
    return 0


if __name__ == "__main__":
    sys.exit(main())

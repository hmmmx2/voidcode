---
title: Byte-pair encoding removes out-of-vocabulary words by construction
concept_id: tokenization
source_name: Sennrich et al., Neural Machine Translation of Rare Words with Subword Units
source_url: https://arxiv.org/abs/1508.07909
published_at: 2015-08-31
---

BPE starts from characters and repeatedly merges the most frequent adjacent pair, building a
vocabulary of subword units. A word never seen in training is represented as a sequence of the
subwords it decomposes into, so there is no out-of-vocabulary case to handle.

The consequences are practical. Token counts do not match word counts, and they differ sharply by
language and by domain: code, non-Latin scripts and rare proper nouns fragment more. Cost and context
limits are denominated in tokens, so this is a budgeting question, not a curiosity.

Byte-level BPE takes the same idea over raw bytes, which guarantees any input is encodable at the
cost of longer sequences for non-ASCII text.

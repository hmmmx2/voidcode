/**
 * Subject matter for the hero demo.
 *
 * Scaled dot-product attention is the canonical ML implementation interview
 * question, and it is chosen here for a specific property: the two classic
 * mistakes are *pedagogically* different from each other.
 *
 * The missing `/ sqrt(d_k)` is a reasoning bug — it has a why (dot products grow
 * with dimension, softmax saturates, gradients vanish) that a tutor can walk a
 * candidate to without writing anything.
 *
 * The `dim=-2` softmax is a mechanical bug, and it is the better demo of the
 * two: the code runs without error, returns a tensor of the right shape, and
 * produces plausible-looking numbers. It fails only a test that checks the
 * attention rows sum to 1. That is exactly the class of bug an autocomplete
 * model will happily leave in place and a candidate will fail an on-site over.
 *
 * NOTE: this is authored demo content, not drawn from the problem bank.
 *
 * THE REASON GIVEN HERE HAS EXPIRED. It read "the shipped catalogue is classical
 * DSA and contains no ML material at all". The catalogue is now 200 items and
 * entirely ML/GPU, and it contains this exact problem —
 * `content/problems/scaled-dot-product-attention.yaml`, order_index 5.
 *
 * The two disagree on every field that matters: this demo takes torch tensors
 * shaped (batch, heads, seq, d_k) with an optional additive mask; the catalogue
 * item takes 2-D Python lists with a boolean `causal` flag and forbids torch
 * outright. So the demo shows a workspace the product does not have.
 *
 * Kept for now because rewriting it against the real item is a design change to
 * the marketing page rather than a copy fix, and a half-migrated demo is worse
 * than an honest note. Tracked in `docs/CONTENT.md`.
 */

export const DEMO_LANGUAGE = "Python";

export const DEMO_PROBLEM = {
  title: "Scaled Dot-Product Attention",
  difficulty: "Medium" as const,
  track: "ML Implementation",
  description:
    "Implement the attention operation from Vaswani et al. Given query, key and value tensors of shape (batch, heads, seq, d_k), return the attended values. Support an optional additive causal mask.",
  signature: "scaled_dot_product_attention(Q, K, V, mask=None) -> Tensor",
  constraints: [
    "No torch.nn.functional.scaled_dot_product_attention",
    "Must be numerically stable for d_k up to 512",
    "Attention weights must form a valid distribution",
  ],
} as const;

/**
 * The starting buffer, with both bugs planted. Indentation is significant —
 * this string is loaded straight into the editor model.
 */
export const DEMO_STARTER_CODE = `import torch, math


def scaled_dot_product_attention(Q, K, V, mask=None):
    """Q, K, V: (batch, heads, seq, d_k)"""
    scores = Q @ K.transpose(-2, -1)

    if mask is not None:
        scores = scores.masked_fill(mask == 0, float("-inf"))

    attn = torch.softmax(scores, dim=-2)
    return attn @ V
`;

/**
 * What the tutor inserts during beat 2. Questions and structure — never the
 * answer. The `____` convention is the same one the real tutor uses in
 * `VoidCodeAIPanel.tsx`, where the system prompt says in as many words: "Do NOT
 * write a solution. Do NOT fill in any blanks."
 */
export const DEMO_SCAFFOLD = `    d_k = Q.size(-1)
    # scale the scores by ____ — why this factor, and not d_k itself?
    # each query distributes attention over which axis?
    # which axis must sum to 1?`;

/**
 * Where the scaffold goes. Anchored rather than appended: the scaling step
 * belongs immediately after the raw scores are computed, and a hint that lands
 * below `return` is a hint the visitor has to mentally relocate before it means
 * anything.
 */
export const DEMO_SCAFFOLD_ANCHOR = "scores = Q @ K.transpose(-2, -1)";

export const DEMO_TESTS = [
  { label: "shape", detail: "(2, 8, 16, 64) -> (2, 8, 16, 64)" },
  { label: "causal mask", detail: "no attention above the diagonal" },
  { label: "rows sum to 1", detail: "attn.sum(-1) == ones" },
] as const;

/**
 * Structural markers used to grade the buffer without executing anything.
 *
 * The demo never calls Judge0. Putting a remote code execution service behind an
 * unauthenticated public page is an unmetered cost line and an abuse surface,
 * and a four-second unpredictable stall in the hero is worse than a convincing
 * fake. But a visitor who *actually* fixes both bugs should not be told they
 * failed — so Run greps for the fix instead of running it, and reports honestly
 * either way.
 */
export function gradeBuffer(source: string): { passed: number; total: number } {
  const scaled = /math\.sqrt|\*\*\s*0?\.5|\bsqrt\s*\(|d_k\s*\*\*/.test(source);
  const correctAxis = /softmax\s*\([^)]*dim\s*=\s*-?1\b/.test(source);

  // Shape and mask are correct in the starting buffer and stay correct through
  // both fixes, so they always pass. Only the third test discriminates.
  return { passed: 2 + (scaled && correctAxis ? 1 : 0), total: 3 };
}

# VoidCode AI — Design Notes

Spec §0 rule 9: a short problem statement per phase, written *before* coding. Two
paragraphs — what the business problem is, and how it becomes an analytical problem.
Written while the work is fresh rather than reconstructed later.

---

## Phase 2 — Learner mastery from submission telemetry

**The business problem.** A programming tutor that recommends the same next problem to
everyone is a syllabus, not a tutor. To personalise, the platform has to know what each
learner is actually weak at — and "weak" is not the same as "gets things wrong". A learner
who fails four hard graph problems is not weaker than one who passes four easy loops; they
are attempting harder work. Equally, a learner who eventually solves everything after
fifteen attempts has not mastered the concept, they have persisted. The product decision
this feeds is concrete: given a learner and a catalog of problems, which concepts should
the next hour of their time be spent on. Getting it wrong is expensive in a way that is
invisible — the learner drifts, does easy problems, feels productive, and does not improve.

**As an analytical problem.** Submission telemetry gives a sparse, unbalanced
learner × problem matrix of binary outcomes, where who attempted what is not random:
stronger learners self-select into harder problems. A raw pass rate per concept therefore
confounds learner ability with item difficulty and cannot be compared across learners. The
formulation is a one-parameter item response (Rasch) model,
`P(solve) = sigmoid(θ_learner − β_problem)`, fitted jointly over the whole matrix so
ability and difficulty are separated. Concept mastery then becomes a **residual**: the mean
of `observed − predicted` over the problems tagged with that concept, which is by
construction net of both the learner's overall ability and the difficulty of what they
happened to attempt. Because a residual from one observation is nearly meaningless, the
residual is carried forward with its standard error and consumed as a z-score. Validation
is external and non-circular: Codeforces publishes a difficulty rating the model never
sees, so `corr(β, published rating)` is a falsifiable check that the model estimates
difficulty rather than memorising the matrix. Around this sit the supporting questions — do
learners fall into stable archetypes (clustering, selected by silhouette and BIC rather
than by eye), and which concepts fail together more than chance predicts (association rule
mining, controlled for the fact that one problem is tagged with up to four concepts and so
manufactures co-failure by construction).

---

## Phase 3 — Ranking practice problems against measured weakness

**The business problem.** Knowing a learner is weak at binary search does not tell you which
of eleven thousand problems to give them next. The catalog is far too large to browse, most
of it is either trivially easy or hopelessly hard for any given learner, and the ordering
matters: a problem whose prerequisite the learner has not met wastes their time and teaches
them that the platform does not understand them. The deliverable is an assembled course —
prerequisite-ordered modules of five to eight problems — and the business metric behind it
is completion within seven days, not click-through. What makes this hard commercially is
that the obviously "correct" recommendation is wrong: recommending problems the learner
will certainly pass produces excellent engagement metrics and no learning.

**As an analytical problem.** This is two-stage retrieval and ranking. Stage one reduces
eleven thousand candidates to a few hundred per learner from three complementary signals —
concept match against the weakest residuals, collaborative similarity over learners with
comparable mastery, and a prerequisite-graph walk that surfaces the missing foundation
underneath a failure — evaluated by Recall@100 against what the learner subsequently
attempted. Stage two is learning-to-rank: LightGBM with a LambdaMART objective, grouped by
learner, over graded relevance. The label design is where the pedagogical claim enters and
must be argued rather than assumed: a problem the learner struggled with and then passed is
graded *above* one they passed first time, which encodes desirable difficulty and directly
contradicts a naive click-through target. Two threats dominate the evaluation and both are
addressed structurally rather than by inspection. Temporal leakage: every feature must be
rebuilt from a pre-cutoff window, because features computed over the whole corpus encode
the future and the resulting NDCG is silently inflated. And in-sample evaluation: a temporal
split alone still reports on learners the ranker trained on, so a learner-level hold-out is
layered on top — the same objection this project already documented against its own
in-sample IRT log loss. Success is NDCG@10 beating an *ability-matched* difficulty baseline
with non-overlapping bootstrap confidence intervals, not beating a strawman.

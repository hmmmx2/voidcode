# sql/tests

Assertions over the models in `sql/models/`. Required by spec 4.1a: row counts, null rates, and
referential integrity on every model.

**Each file is a SELECT that returns one row per problem found. Empty result means pass.** A test that
returned a boolean would report `false` and leave you to find the offending row; returning the rows
means a failure arrives with its own evidence.

Run them with the models loaded as temp views:

    source $HOME/.voidcode/env.sh && python -m sql.run_models --test

`sql/run_models.py` registers each model under its filename with the numeric prefix stripped, so these
files reference `cohort_retention`, `concept_difficulty_ranking`, and so on.

Every assertion below states the failure it is written to catch. An assertion whose failure mode
nobody can name tends to be one that cannot fail.

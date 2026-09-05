-- How the error mix shifts over time. Model 4 of 6.
--
-- Share of each verdict bucket per month, with the month-over-month change. Shares rather than
-- counts: submission volume swings with contest scheduling, so raw counts move for reasons that have
-- nothing to do with what learners get wrong.
--
-- ACCEPTED IS EXCLUDED. This is an ERROR taxonomy; leaving accepted in would make every share a
-- function of the overall pass rate rather than of the error mix. The accepted share is model 3.
--
-- A thin month produces a noisy share, so n_submissions and month_total stay on every row. Do not
-- read share_delta without them: the first and last months of an ingest window are partial.
--
-- Technique: window functions twice — SUM(...) OVER (PARTITION BY month) normalises within a month
-- without a second aggregation, then LAG() over each bucket's own time series gives the delta.
WITH monthly AS (
    SELECT DATE_TRUNC('MONTH', submission_ts) AS month,
           error_bucket,
           COUNT(*) AS n_submissions
    FROM silver_submissions
    WHERE error_bucket IS NOT NULL
      AND is_accepted = 0
    GROUP BY DATE_TRUNC('MONTH', submission_ts), error_bucket
),
shares AS (
    SELECT month,
           error_bucket,
           n_submissions,
           SUM(n_submissions) OVER (PARTITION BY month) AS month_total,
           n_submissions / SUM(n_submissions) OVER (PARTITION BY month) AS share
    FROM monthly
)
SELECT month,
       error_bucket,
       n_submissions,
       month_total,
       ROUND(share, 6) AS share,
       ROUND(LAG(share) OVER (PARTITION BY error_bucket ORDER BY month), 6) AS prev_share,
       ROUND(share - LAG(share) OVER (PARTITION BY error_bucket ORDER BY month), 6) AS share_delta
FROM shares
ORDER BY month, share DESC

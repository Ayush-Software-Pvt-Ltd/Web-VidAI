-- Why a change request failed (docs/SPEC.md section 11, Change requests): the sentence of the job
-- that failed or was stopped, kept with the request because the job may be gone from the page's
-- memory (and ended jobs are pruned). NULL for every request that has not failed.
ALTER TABLE notes ADD COLUMN error TEXT;

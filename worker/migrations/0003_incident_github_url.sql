-- Store the GitHub issue's html_url on the incident instead of letting the
-- page reconstruct it from a hardcoded repo: links stay correct across
-- GITHUB_REPO changes (sandbox testing, repo moves) and for historic rows.
ALTER TABLE incidents ADD COLUMN github_url TEXT;

-- Human-readable incident description (the same markdown posted to the GitHub
-- issue): which requests drove the evaluation — path, code, latency, body.
-- Stored in D1 so the page can show it without GitHub (no token, no rate limits).
ALTER TABLE incidents ADD COLUMN report TEXT;

-- Keep the captured Laravel route template separate from its optional route name.
-- Historical rows remain NULL: a concrete URL is not a reliable route template.
ALTER TABLE traces ADD COLUMN route_path TEXT;

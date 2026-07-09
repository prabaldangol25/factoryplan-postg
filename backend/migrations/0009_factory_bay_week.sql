CREATE TABLE IF NOT EXISTS factory_bay_week (
    id          TEXT PRIMARY KEY,
    factory_id  TEXT NOT NULL REFERENCES factory(id) ON DELETE CASCADE,
    week_start  TEXT NOT NULL,
    bays        BIGINT NOT NULL CHECK (bays >= 0),
    UNIQUE (factory_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_factory_bay_week_factory ON factory_bay_week(factory_id);

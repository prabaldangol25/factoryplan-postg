CREATE TABLE IF NOT EXISTS scenario_order (
    id              TEXT PRIMARY KEY,
    scenario_id     TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    utid            TEXT NOT NULL,
    customer        TEXT NOT NULL,
    cycle_time_days BIGINT NOT NULL CHECK (cycle_time_days > 0),
    sort_order      BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scenario_order_scenario ON scenario_order(scenario_id);

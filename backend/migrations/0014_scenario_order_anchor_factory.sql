ALTER TABLE scenario_order ADD COLUMN IF NOT EXISTS anchor_factory_id TEXT REFERENCES factory(id) ON DELETE SET NULL;

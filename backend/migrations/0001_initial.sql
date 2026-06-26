CREATE TABLE scenario (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE factory (
    id              TEXT PRIMARY KEY,
    scenario_id     TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    bays            BIGINT NOT NULL CHECK (bays >= 0),
    changeover_days BIGINT NOT NULL DEFAULT 0 CHECK (changeover_days >= 0)
);
CREATE INDEX idx_factory_scenario ON factory(scenario_id);

CREATE TABLE factory_bay_count (
    id          TEXT PRIMARY KEY,
    factory_id  TEXT NOT NULL REFERENCES factory(id) ON DELETE CASCADE,
    year        BIGINT NOT NULL,
    quarter     BIGINT NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    bays        BIGINT NOT NULL CHECK (bays >= 0),
    UNIQUE (factory_id, year, quarter)
);
CREATE INDEX idx_factory_bay_count_factory ON factory_bay_count(factory_id);

CREATE TABLE product (
    id          TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    name        TEXT NOT NULL
);
CREATE INDEX idx_product_scenario ON product(scenario_id);

CREATE TABLE product_lead_time (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    year            BIGINT NOT NULL,
    quarter         BIGINT NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    lead_time_days  BIGINT NOT NULL CHECK (lead_time_days > 0),
    UNIQUE (product_id, year, quarter)
);
CREATE INDEX idx_lead_time_product ON product_lead_time(product_id);

CREATE TABLE product_factory_lead_time (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    factory_id      TEXT NOT NULL REFERENCES factory(id) ON DELETE CASCADE,
    year            BIGINT NOT NULL,
    quarter         BIGINT NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    lead_time_days  BIGINT NOT NULL CHECK (lead_time_days > 0),
    UNIQUE (product_id, factory_id, year, quarter)
);
CREATE INDEX idx_pflt_product ON product_factory_lead_time(product_id);
CREATE INDEX idx_pflt_factory ON product_factory_lead_time(factory_id);

CREATE TABLE product_factory_allocation (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    factory_id      TEXT NOT NULL REFERENCES factory(id) ON DELETE CASCADE,
    year            BIGINT NOT NULL,
    quarter         BIGINT NOT NULL CHECK (quarter BETWEEN 0 AND 4),
    allocation_pct  BIGINT NOT NULL CHECK (allocation_pct BETWEEN 0 AND 100),
    CHECK ((year = 0 AND quarter = 0) OR (year > 0 AND quarter BETWEEN 1 AND 4)),
    UNIQUE (product_id, year, quarter)
);
CREATE INDEX idx_pfa_product ON product_factory_allocation(product_id);
CREATE INDEX idx_pfa_factory ON product_factory_allocation(factory_id);

CREATE TABLE demand (
    id              TEXT PRIMARY KEY,
    scenario_id     TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    period_type     TEXT NOT NULL CHECK (period_type IN ('month', 'quarter')),
    year            BIGINT NOT NULL,
    period_index    BIGINT NOT NULL,
    quantity        BIGINT NOT NULL CHECK (quantity > 0),
    spread_mode     TEXT NOT NULL DEFAULT 'even' CHECK (spread_mode IN ('even', 'start', 'end')),
    serial_mode     TEXT NOT NULL DEFAULT 'none' CHECK (serial_mode IN ('none', 'sequence', 'list')),
    serial_start    TEXT,
    serial_list     TEXT
);
CREATE INDEX idx_demand_scenario ON demand(scenario_id);
CREATE INDEX idx_demand_product ON demand(product_id);

CREATE TABLE schedule_run (
    id                  TEXT PRIMARY KEY,
    scenario_id         TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    run_at              TEXT NOT NULL,
    total_demand        BIGINT NOT NULL,
    shipped_on_time     BIGINT NOT NULL,
    shipped_late        BIGINT NOT NULL DEFAULT 0,
    unshippable         BIGINT NOT NULL
);
CREATE INDEX idx_run_scenario ON schedule_run(scenario_id);

CREATE TABLE scheduled_unit (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
    demand_id       TEXT NOT NULL,
    product_id      TEXT NOT NULL,
    factory_id      TEXT,
    bay_index       BIGINT,
    required_start  TEXT NOT NULL,
    due_date        TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('shipped', 'unshippable')),
    serial          TEXT,
    orig_due_date   TEXT,
    is_late         BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_unit_run ON scheduled_unit(run_id);

CREATE TABLE recommendation (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
    rec_type        TEXT NOT NULL CHECK (rec_type IN ('bays_needed', 'uniform_lt_pct', 'per_product_lt')),
    payload_json    TEXT NOT NULL
);
CREATE INDEX idx_rec_run ON recommendation(run_id);

CREATE TABLE quarter_miss (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
    year         BIGINT NOT NULL,
    quarter      BIGINT NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    missed_count BIGINT NOT NULL CHECK (missed_count >= 0)
);
CREATE INDEX idx_quarter_miss_run ON quarter_miss(run_id);

CREATE TABLE agent_conversation (
    id          TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    title       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_agent_conv_scenario ON agent_conversation(scenario_id);

CREATE TABLE agent_message (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX idx_agent_msg_conv ON agent_message(conversation_id);

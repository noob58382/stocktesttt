CREATE TABLE IF NOT EXISTS stock_state (
    part_number TEXT NOT NULL,
    store_id TEXT NOT NULL,
    store_name TEXT NOT NULL,
    available INTEGER NOT NULL DEFAULT 0,
    pickup_quote TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (part_number, store_id)
);

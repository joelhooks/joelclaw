CREATE TABLE IF NOT EXISTS joelclaw_private.message_journal_events
(
    schema_version UInt16 DEFAULT 1,

    -- Stable, deterministic identity for one lifecycle transition.
    journal_event_id String,
    message_key String,
    flow_id String,

    channel LowCardinality(String) DEFAULT 'telegram',
    direction LowCardinality(String),       -- inbound | outbound | interaction
    event_type LowCardinality(String),      -- message.received, delivery.confirmed, etc.
    content_kind LowCardinality(String) DEFAULT 'text',

    occurred_at DateTime64(3, 'UTC'),
    event_date Date MATERIALIZED toDate(occurred_at),
    recorded_at DateTime64(3, 'UTC') DEFAULT now64(3),

    producer LowCardinality(String),
    origin_system_id LowCardinality(String),
    source_event_id Nullable(String),
    source_ref String DEFAULT '',
    route String DEFAULT '',

    classification LowCardinality(String) DEFAULT 'unclassified',
    reason String DEFAULT '',
    investigation_state LowCardinality(String) DEFAULT '',
    investigation_result String DEFAULT '',

    telegram_chat_id Int64,
    telegram_message_id Nullable(Int64),
    telegram_update_id Nullable(Int64),
    in_reply_to_message_id Nullable(Int64),

    callback_query_id Nullable(String),
    interaction_action String DEFAULT '',
    interaction_payload String DEFAULT '',
    interaction_outcome LowCardinality(String) DEFAULT '',

    chunk_index Nullable(UInt16),
    revision UInt32 DEFAULT 1,
    attempt UInt16 DEFAULT 1,

    -- `text`: canonical user-visible text.
    -- `transport_text`: exact Bot API payload, including HTML markup when used.
    text String DEFAULT '' CODEC(ZSTD(3)),
    transport_text String DEFAULT '' CODEC(ZSTD(3)),
    content_hash String DEFAULT '',
    content_chars UInt32 DEFAULT 0,
    content_bytes UInt32 DEFAULT 0,

    delivery_state LowCardinality(String) DEFAULT '',
    error_code LowCardinality(String) DEFAULT '',
    metadata_json String DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_flow flow_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_message_key message_key TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_telegram_message
        ifNull(telegram_message_id, toInt64(-1))
        TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(recorded_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (
    channel,
    event_date,
    occurred_at,
    direction,
    flow_id,
    journal_event_id
);

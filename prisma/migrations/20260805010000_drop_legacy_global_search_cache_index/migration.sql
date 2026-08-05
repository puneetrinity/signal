-- The tenant migration tried to remove this CREATE UNIQUE INDEX object with
-- DROP CONSTRAINT. Verify its tenant-scoped replacement before dropping it.
DO $migration$
DECLARE
    cache_table REGCLASS;
    legacy_table_oid OID;
    legacy_is_unique BOOLEAN;
    legacy_is_valid BOOLEAN;
    legacy_has_predicate BOOLEAN;
    legacy_has_expressions BOOLEAN;
    legacy_columns TEXT[];
BEGIN
    cache_table := to_regclass(
        format('%I.%I', current_schema(), 'search_cache_v2')
    );
    IF cache_table IS NULL THEN
        RAISE EXCEPTION 'search cache index repair requires the search_cache_v2 table';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class index_class
        JOIN pg_namespace namespace
          ON namespace.oid = index_class.relnamespace
        JOIN pg_index index_metadata
          ON index_metadata.indexrelid = index_class.oid
        WHERE namespace.nspname = current_schema()
          AND index_metadata.indrelid = cache_table
          AND index_class.relname = 'search_cache_v2_tenantId_queryHash_key'
          AND index_metadata.indisunique
          AND index_metadata.indisvalid
          AND index_metadata.indisready
          AND index_metadata.indpred IS NULL
          AND index_metadata.indexprs IS NULL
          AND (
              SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
              FROM unnest(index_metadata.indkey) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = index_metadata.indrelid
               AND attribute.attnum = key.attnum
          ) = ARRAY['tenantId', 'queryHash']::TEXT[]
    ) THEN
        RAISE EXCEPTION 'required tenant-scoped search cache index is missing or invalid';
    END IF;

    SELECT
        index_metadata.indrelid,
        index_metadata.indisunique,
        index_metadata.indisvalid AND index_metadata.indisready,
        index_metadata.indpred IS NOT NULL,
        index_metadata.indexprs IS NOT NULL,
        (
            SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
            FROM unnest(index_metadata.indkey) WITH ORDINALITY AS key(attnum, ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid = index_metadata.indrelid
             AND attribute.attnum = key.attnum
        )
    INTO
        legacy_table_oid,
        legacy_is_unique,
        legacy_is_valid,
        legacy_has_predicate,
        legacy_has_expressions,
        legacy_columns
    FROM pg_class index_class
    JOIN pg_namespace namespace
      ON namespace.oid = index_class.relnamespace
    JOIN pg_index index_metadata
      ON index_metadata.indexrelid = index_class.oid
    WHERE namespace.nspname = current_schema()
      AND index_class.relname = 'search_cache_v2_queryHash_key';

    IF legacy_table_oid IS NOT NULL AND (
        legacy_table_oid IS DISTINCT FROM cache_table
        OR legacy_is_unique IS NOT TRUE
        OR legacy_is_valid IS NOT TRUE
        OR legacy_has_predicate IS NOT FALSE
        OR legacy_has_expressions IS NOT FALSE
        OR legacy_columns IS DISTINCT FROM ARRAY['queryHash']::TEXT[]
    ) THEN
        RAISE EXCEPTION 'refusing to drop unexpected index object search_cache_v2_queryHash_key';
    END IF;

    EXECUTE format(
        'DROP INDEX IF EXISTS %I.%I',
        current_schema(),
        'search_cache_v2_queryHash_key'
    );
END
$migration$;

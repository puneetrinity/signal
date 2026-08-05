-- The tenant migration added the correct composite unique indexes but tried to
-- remove these legacy CREATE UNIQUE INDEX objects with DROP CONSTRAINT. Verify
-- the replacement indexes and data before removing only the obsolete pair.
DO $migration$
DECLARE
    candidate_table REGCLASS;
    legacy_name TEXT;
    expected_column TEXT;
    legacy_table_oid OID;
    legacy_is_unique BOOLEAN;
    legacy_is_valid BOOLEAN;
    legacy_columns TEXT[];
    has_duplicates BOOLEAN;
BEGIN
    candidate_table := to_regclass(
        format('%I.%I', current_schema(), 'candidates')
    );
    IF candidate_table IS NULL THEN
        RAISE EXCEPTION 'candidate index repair requires the candidates table';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class index_class
        JOIN pg_namespace namespace
          ON namespace.oid = index_class.relnamespace
        JOIN pg_index index_metadata
          ON index_metadata.indexrelid = index_class.oid
        WHERE namespace.nspname = current_schema()
          AND index_metadata.indrelid = candidate_table
          AND index_class.relname = 'candidates_tenantId_linkedinId_key'
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
          ) = ARRAY['tenantId', 'linkedinId']::TEXT[]
    ) THEN
        RAISE EXCEPTION 'required tenant-scoped linkedinId index is missing or invalid';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class index_class
        JOIN pg_namespace namespace
          ON namespace.oid = index_class.relnamespace
        JOIN pg_index index_metadata
          ON index_metadata.indexrelid = index_class.oid
        WHERE namespace.nspname = current_schema()
          AND index_metadata.indrelid = candidate_table
          AND index_class.relname = 'candidates_tenantId_linkedinUrl_key'
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
          ) = ARRAY['tenantId', 'linkedinUrl']::TEXT[]
    ) THEN
        RAISE EXCEPTION 'required tenant-scoped linkedinUrl index is missing or invalid';
    END IF;

    EXECUTE format(
        'SELECT EXISTS (
            SELECT 1
            FROM %I.%I
            WHERE "linkedinId" IS NOT NULL
            GROUP BY "tenantId", "linkedinId"
            HAVING COUNT(*) > 1
        )',
        current_schema(),
        'candidates'
    ) INTO has_duplicates;
    IF has_duplicates THEN
        RAISE EXCEPTION 'tenant-scoped linkedinId duplicates block candidate index repair';
    END IF;

    EXECUTE format(
        'SELECT EXISTS (
            SELECT 1
            FROM %I.%I
            WHERE "linkedinUrl" IS NOT NULL
            GROUP BY "tenantId", "linkedinUrl"
            HAVING COUNT(*) > 1
        )',
        current_schema(),
        'candidates'
    ) INTO has_duplicates;
    IF has_duplicates THEN
        RAISE EXCEPTION 'tenant-scoped linkedinUrl duplicates block candidate index repair';
    END IF;

    FOR legacy_name, expected_column IN
        SELECT *
        FROM (VALUES
            ('candidates_linkedinId_key', 'linkedinId'),
            ('candidates_linkedinUrl_key', 'linkedinUrl')
        ) AS expected(name, column_name)
    LOOP
        legacy_table_oid := NULL;
        legacy_is_unique := NULL;
        legacy_is_valid := NULL;
        legacy_columns := NULL;

        SELECT
            index_metadata.indrelid,
            index_metadata.indisunique,
            index_metadata.indisvalid AND index_metadata.indisready,
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
            legacy_columns
        FROM pg_class index_class
        JOIN pg_namespace namespace
          ON namespace.oid = index_class.relnamespace
        JOIN pg_index index_metadata
          ON index_metadata.indexrelid = index_class.oid
        WHERE namespace.nspname = current_schema()
          AND index_class.relname = legacy_name;

        IF legacy_table_oid IS NOT NULL AND (
            legacy_table_oid IS DISTINCT FROM candidate_table
            OR legacy_is_unique IS NOT TRUE
            OR legacy_is_valid IS NOT TRUE
            OR legacy_columns IS DISTINCT FROM ARRAY[expected_column]::TEXT[]
        ) THEN
            RAISE EXCEPTION 'refusing to drop unexpected index object %', legacy_name;
        END IF;
    END LOOP;

    EXECUTE format(
        'DROP INDEX IF EXISTS %I.%I',
        current_schema(),
        'candidates_linkedinId_key'
    );
    EXECUTE format(
        'DROP INDEX IF EXISTS %I.%I',
        current_schema(),
        'candidates_linkedinUrl_key'
    );
END
$migration$;

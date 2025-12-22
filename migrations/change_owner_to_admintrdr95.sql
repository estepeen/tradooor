-- Change owner of all tables and sequences to admintrdr95
-- Run this as postgres user: sudo -u postgres psql tradooor -f migrations/change_owner_to_admintrdr95.sql

-- Change owner of all tables in public schema
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
    LOOP
        EXECUTE 'ALTER TABLE public."' || r.tablename || '" OWNER TO admintrdr95';
    END LOOP;
END $$;

-- Change owner of all sequences in public schema
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN 
        SELECT sequence_name 
        FROM information_schema.sequences 
        WHERE sequence_schema = 'public'
    LOOP
        EXECUTE 'ALTER SEQUENCE public."' || r.sequence_name || '" OWNER TO admintrdr95';
    END LOOP;
END $$;

-- Verify changes
SELECT tablename, tableowner
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;


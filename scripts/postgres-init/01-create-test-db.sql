-- Creates the disposable test database used by the integration suite.
-- Runs only on first initialization of an empty PostgreSQL data volume.
SELECT 'CREATE DATABASE odft_test OWNER odft'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'odft_test')\gexec

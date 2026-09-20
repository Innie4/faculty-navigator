-- Runs once when the postgres container's data volume is first created.
-- POSTGRES_DB (see docker-compose.yml) provisions the dev database;
-- this creates the second database the test suite connects to by default.
CREATE DATABASE faculty_navigator_test;

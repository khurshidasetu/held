-- Runs once, on the first container start (when the data directory is empty).
-- Subsequent starts skip this entirely, so it's safe to leave in place.
--
-- The compose file already sets MYSQL_DATABASE=minutely, which means the base
-- image creates the schema for us. We just add an application-scoped user
-- with limited privileges so `.env.local` doesn't have to use the root
-- account. The web app can use either user — see web/.env.example.

CREATE USER IF NOT EXISTS 'minutely'@'%' IDENTIFIED BY 'minutely';
GRANT ALL PRIVILEGES ON `minutely`.* TO 'minutely'@'%';
FLUSH PRIVILEGES;

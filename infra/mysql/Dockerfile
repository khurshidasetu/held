# MySQL image for the Held web app.
#
# Extends the official mysql:8.0 with:
#   - A tuned my.cnf (utf8mb4 + UTC + small connection pool for dev/small prod)
#   - First-start init SQL that creates the `held` schema and an
#     application user with limited scope.
#
# The image deliberately doesn't bake in any database content; data lives in a
# named Docker volume (see docker-compose.yml) so it survives container
# replacement.
FROM mysql:8.0

# Custom configuration. Files dropped into /etc/mysql/conf.d are merged with
# the defaults at startup, so we only need to specify what we're changing.
COPY my.cnf /etc/mysql/conf.d/held.cnf

# Anything dropped into /docker-entrypoint-initdb.d runs *once*, on the very
# first container start (when the data directory is empty). We use it to set
# up an application user; subsequent starts skip this entirely.
COPY init/ /docker-entrypoint-initdb.d/

# Make sure mysql can read the config. (The base image runs as root inside
# the entrypoint and switches to the `mysql` user for the server.)
RUN chmod 0644 /etc/mysql/conf.d/held.cnf

"""Verify that concurrent database initialization doesn't crash.

Multiple gunicorn workers start simultaneously and each opens the same
LNT instance, triggering V4DB.__init__() which runs migrate.update()
and _load_schemas(). This test ensures that the full initialization
path is safe under concurrent access.
"""
# RUN: rm -rf "%t.instance" "%t.pg.log"
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance

import os
import sys
import threading
import traceback

import sqlalchemy

import lnt.server.instance
import lnt.server.db.migrate


instance_path = sys.argv[1]

# Drop all tables to simulate a fresh database, so that concurrent
# Instance.frompath() calls must run the full initialization path
# (migrations + schema loading) rather than finding everything
# already in place.
db_uri = os.environ['LNT_TEST_DB_URI']
db_name = os.environ['LNT_TEST_DB_NAME']
engine = sqlalchemy.create_engine('%s/%s' % (db_uri, db_name))
with engine.begin() as conn:
    conn.execute(sqlalchemy.text("DROP SCHEMA public CASCADE"))
    conn.execute(sqlalchemy.text("CREATE SCHEMA public"))
engine.dispose()

NUM_WORKERS = 4
barrier = threading.Barrier(NUM_WORKERS, timeout=60)
errors = []
lock = threading.Lock()


def init_instance():
    try:
        barrier.wait() # wait for all workers to arrive
        lnt.server.instance.Instance.frompath(instance_path)
    except Exception as e:
        with lock:
            errors.append((threading.current_thread().name, e, traceback.format_exc()))


threads = [threading.Thread(target=init_instance, name='worker-%d' % i)
           for i in range(NUM_WORKERS)]
for t in threads:
    t.start()
for t in threads:
    t.join(timeout=120)

hung = [t for t in threads if t.is_alive()]
if hung:
    print("FAIL: %d worker(s) still running after timeout" % len(hung))
    sys.exit(1)

if errors:
    print("FAIL: %d of %d workers failed during concurrent initialization:"
          % (len(errors), NUM_WORKERS))
    for name, exc, tb in errors:
        print("\n--- %s ---" % name)
        print(tb)
    sys.exit(1)

# Verify the database is properly initialized.
engine = sqlalchemy.create_engine('%s/%s' % (db_uri, db_name))
session = sqlalchemy.orm.sessionmaker(engine)()

sv = session.query(lnt.server.db.migrate.SchemaVersion) \
    .filter_by(name='__core__').first()
migrations = lnt.server.db.migrate._load_migrations()
expected = migrations['__core__']['current_version']
assert sv is not None, "SchemaVersion not found"
assert sv.version == expected, \
    "Expected version %d, got %d" % (expected, sv.version)

session.close()
engine.dispose()

print("PASS: All %d workers completed concurrent initialization successfully "
      "(schema version: %d)" % (NUM_WORKERS, sv.version))

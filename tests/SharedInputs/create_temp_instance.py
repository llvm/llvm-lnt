import sys
import shutil
import os.path
import os
import subprocess
import hashlib
import tempfile
import re


def get_postgres_db_uri():
    return os.environ.get('LNT_POSTGRES_DB_URI')


def get_postgres_tmp_db_name(test_name):
    return "lnt_regr_test_" + hashlib.md5(test_name).hexdigest()


def search_replace_in_file_with_function(filename, replacement_function):
    with open(filename, "r+") as f:
        old_content = f.read()
        new_content = replacement_function(old_content)
        f.seek(0)
        f.truncate()
        f.write(new_content)


def search_replace_regex_in_file(filename, pattern, substitution):
    return search_replace_in_file_with_function(
        filename,
        lambda c: re.sub(pattern, substitution, c))


def search_replace_in_file(filename, pattern, substitution):
    return search_replace_in_file_with_function(
        filename,
        lambda c: c.replace(pattern, substitution))


def replace_sqlite_with_postgress_syntax(sql_file):
    search_replace_regex_in_file(
        sql_file,
        r"CAST *\(('.*') AS BLOB\)",
        r"convert_to(\1, 'UTF8')")
    search_replace_in_file(sql_file, "BLOB", "bytea")
    search_replace_in_file(sql_file, "DATETIME", "timestamp")
    search_replace_in_file(sql_file, "INTEGER PRIMARY KEY", "serial primary key")


def run_sql_file(db, sql_file, dest_dir):
    """
    Run the sql statements in file sql_file on the database in db.
    The sql statements in sql_file are assumed to be in the sqlite
    dialect. When run against a different database engine, this function
    will try to translate the sqlite-isms into the corresponding SQL
    variants for the engine targetted.
    """
    if get_postgres_db_uri():
        # translate sql_file from slqite-dialect to postgrest-dialect:
        tmpfile = tempfile.NamedTemporaryFile(
            prefix=os.path.basename(sql_file),
            suffix=".psql",
            dir=dest_dir, delete=False)
        with open(sql_file, "r") as f:
            tmpfile.write(f.read())
        tmpfile_name = tmpfile.name
        tmpfile.close()
        replace_sqlite_with_postgress_syntax(tmpfile_name)
        cmd = "psql %s -f %s" % (db, tmpfile_name)
    else:
        cmd = "sqlite3 -batch %s < %s" % (db, sql_file)
    print cmd
    subprocess.check_call(cmd, shell="True")


def run_sql_cmd(db, sql_cmd):
    if get_postgres_db_uri():
        cmd = 'echo "%s" | psql %s' % (sql_cmd, db)
    else:
        cmd = 'echo "%s" | sqlite3 -batch %s' % (sql_cmd, db)
    print cmd
    subprocess.check_call(cmd, shell="True")


def create_tmp_database(db, test_name, dest_dir):
    if get_postgres_db_uri():
        tmp_db_name = get_postgres_tmp_db_name(test_name)
        run_sql_cmd(get_postgres_db_uri(),
                    "drop database if exists %s;" % tmp_db_name)
        run_sql_cmd(get_postgres_db_uri(),
                    "create database %s;" % tmp_db_name)
        # adapt lnt.cfg so it points to the postgres db instead of the default
        # sqlite db.
        search_replace_in_file(
            os.path.join(dest_dir, "lnt.cfg"),
            "db_dir = 'data'",
            "db_dir = '" + get_postgres_db_uri() + "'")
        search_replace_in_file(
            os.path.join(dest_dir, "lnt.cfg"),
            "'path' : 'lnt.db'",
            "'path' : '" + tmp_db_name + "'")
        return get_postgres_db_uri() + "/" + tmp_db_name
    else:
        # sqlite
        os.mkdir(os.path.join(dest_dir, "data"))
        return "%s/lnt.db" % os.path.join(dest_dir, "data")


def main():
    usage = "%s test_name template_source_dir dest_dir [extra.sql]"
    if len(sys.argv) not in (4, 5):
        print usage
        sys.exit(-1)
    if len(sys.argv) == 4:
        _, test_name, template_source_dir, dest_dir = sys.argv
        extra_sql = None
    else:
        _, test_name, template_source_dir, dest_dir, extra_sql = sys.argv

    os.mkdir(os.path.join(dest_dir))
    shutil.copy(os.path.join(template_source_dir, "lnt.cfg"), dest_dir)
    shutil.copy(os.path.join(template_source_dir, "lnt.wsgi"), dest_dir)
    lnt_db = create_tmp_database(get_postgres_db_uri(), test_name, dest_dir)

    run_sql_file(lnt_db,
                 os.path.join(template_source_dir, "data", "lnt_db_create.sql"),
                 dest_dir)
    if extra_sql:
        run_sql_file(lnt_db, extra_sql, dest_dir)
    os.mkdir(os.path.join(dest_dir, 'schemas'))
    filedir = os.path.dirname(__file__)
    os.symlink(os.path.join(filedir, '..', '..', 'schemas', 'nts.yaml'),
               os.path.join(dest_dir, 'schemas', 'nts.yaml'))
    os.symlink(os.path.join(filedir, '..', '..', 'schemas', 'compile.yaml'),
               os.path.join(dest_dir, 'schemas', 'compile.yaml'))


main()

import sys, shutil, os.path, os, subprocess

usage = "%s template_source_dir dest_dir [extra.sql]"

if len(sys.argv) not in (3,4):
    print usage
    sys.exit(-1)
if len(sys.argv) == 3:
    _, template_source_dir, dest_dir = sys.argv
    extra_sql = None
else:
    _, template_source_dir, dest_dir, extra_sql = sys.argv
os.mkdir(os.path.join(dest_dir))
shutil.copy(os.path.join(template_source_dir, "lnt.cfg"), dest_dir)
shutil.copy(os.path.join(template_source_dir, "lnt.wsgi"), dest_dir)
os.mkdir(os.path.join(dest_dir, "data"))
# create sqlite database from sql script
lnt_db = "%s/lnt.db" % os.path.join(dest_dir, "data")
cmd = "sqlite3 -batch %s < %s/lnt_db_create.sql" % \
      (lnt_db,
       os.path.join(template_source_dir,"data"))
subprocess.check_call(cmd, shell="True")
if extra_sql:
    cmd = "sqlite3 -batch %s < %s" % (lnt_db, extra_sql)
    subprocess.check_call(cmd, shell="True")

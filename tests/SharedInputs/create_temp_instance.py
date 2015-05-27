import sys, shutil, os.path, os, subprocess

_, template_sourcedir, dest_dir = sys.argv
os.mkdir(os.path.join(dest_dir))
shutil.copy(os.path.join(template_sourcedir, "lnt.cfg"), dest_dir)
shutil.copy(os.path.join(template_sourcedir, "lnt.wsgi"), dest_dir)
os.mkdir(os.path.join(dest_dir, "data"))
# create sqlite database from sql script
cmd = "sqlite3 -batch %s/lnt.db < %s/lnt_db_create.sql" % \
      (os.path.join(dest_dir,"data"),
       os.path.join(template_sourcedir,"data"))
subprocess.check_call(cmd, shell="True")

# Check that we can perform migration of all of the test instances.
#
# RUN: python %s %t

import logging
import os
import re
import shutil
import sys
import glob

import lnt.server.db.migrate
import lnt.server.ui.app

logging.basicConfig(level=logging.DEBUG)

def sanity_check_instance(instance_path):
    # Create an application instance.
    app = lnt.server.ui.app.App.create_standalone(instance_path)

    # Create a test client.
    client = app.test_client()

    # Fetch the index page.
    index = client.get('/')

    # Visit all the test suites.
    test_suite_link_rex = re.compile("""  <a href="(.*)">(.*)</a><br>""")
    test_suite_list_start = index.data.index("<h3>Test Suites</h3>")
    test_suite_list_end = index.data.index("</div>", test_suite_list_start)
    for ln in index.data[test_suite_list_start:test_suite_list_end].split("\n"):
        # Ignore non-matching lines.
        print >>sys.stderr,ln
        m = test_suite_link_rex.match(ln)
        if not m:
            continue

        # We found a test suite link...
        link,name = m.groups()
        logging.info("visiting test suite %r", name)

        # Get the test suite overview page.
        overview = client.get(os.path.join("/", link))
        assert "LNT : %s - Recent Activity" % (name,) in overview.data

def check_instance(instance_path, temp_path):
    logging.info("checking instance: %r", instance_path)

    # Create a temporary directory to copy the instance into.
    instance_temp_path = os.path.join(temp_path,
                                      os.path.basename(instance_path))

    # Copy the instance into the temporary path.
    logging.info("copying instance to temporary path: %r",
                 instance_temp_path)
    shutil.copytree(instance_path, instance_temp_path)

    # Execute the migration on the instance.
    db_path = os.path.join(instance_temp_path, "data", "lnt.db")
    logging.info("migrating database: %r", db_path)
    lnt.server.db.migrate.update_path(db_path)

    # Sanity check that the update instance works correctly.
    sanity_check_instance(instance_temp_path)

def main():
    _,temp_path = sys.argv

    # Clean the temporary path, if necessary.
    if os.path.exists(temp_path):
        shutil.rmtree(temp_path)
    os.makedirs(temp_path)

    inputs_dir = os.path.join(os.path.dirname(__file__), 'Inputs')

    for item in glob.glob(inputs_dir + '/*'):
        input_path = os.path.join(inputs_dir, item)

        # Ignore non-directories.
        if not os.path.isdir(input_path):
            continue

        # Otherwise, we have a test instance. Check migration of it.
        check_instance(input_path, temp_path)

if __name__ == '__main__':
    main()

# Perform basic sanity checking of the V4 UI pages. Currently this really only
# checks that we don't crash on any of them.
#
# create temporary instance
# Cleanup temporary directory in case one remained from a previous run - also see PR9904.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py %{shared_inputs}/SmallInstance %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import logging
import re
import sys
import xml.etree.ElementTree as ET
from htmlentitydefs import name2codepoint

import lnt.server.db.migrate
import lnt.server.ui.app

logging.basicConfig(level=logging.DEBUG)


def check_code(client, url, expected_code=200):
    resp = client.get(url, follow_redirects=False)
    assert resp.status_code == expected_code, \
        "Call to %s returned: %d, not the expected %d"%(url, resp.status_code, expected_code)
    return resp

def check_redirect(client, url, expected_redirect_regex):
    resp = client.get(url, follow_redirects=False)
    assert resp.status_code == 302, \
        "Call to %s returned: %d, not the expected %d"%(url, resp.status_code, 302)
    regex = re.compile(expected_redirect_regex)
    assert regex.search(resp.location), \
        "Call to %s redirects to: %s, not matching the expected regex %s" \
        % (url, resp.location, expected_redirect_regex)
    return resp


def dump_html(html_string):
   for linenr, line in enumerate(html_string.split('\n')):
      print "%4d:%s" % (linenr+1, line)

def get_xml_tree(html_string):
    try:
        parser = ET.XMLParser()
        parser.parser.UseForeignDTD(True)
        parser.entity.update((x, unichr(i)) for x, i in name2codepoint.iteritems())
        tree = ET.fromstring(html_string, parser=parser)
    except:
       dump_html(html_string)
       raise
    return tree

def check_nr_machines_reported(client, url, expected_nr_machines):
    resp = check_code(client, url)
    html = resp.data
    tree = get_xml_tree(html)
    # look for the table containing the machines on the page.
    # do this by looking for the title containing "Reported Machine Order"
    # and assuming that the first <table> at the same level after it is the
    # one we're looking for.
    reported_machine_order_table = None
    table_parent_elements = tree.findall(".//table/..")
    found_header = False
    for parent in table_parent_elements:
        for child in parent.findall('*'):
            if found_header:
                if child.tag == "table":
                    reported_machine_order_table = child
                    found_header = False
            elif child.tag.startswith('h') and \
                child.text == 'Reported Machine Order':
                found_header = True
    if reported_machine_order_table is None:
        nr_machines = 0
    else:
        nr_machines = len(reported_machine_order_table.findall("./tr"))
    assert expected_nr_machines == nr_machines

def main():
    _,instance_path = sys.argv

    # Create the application instance.
    app = lnt.server.ui.app.App.create_standalone(instance_path)

    # Don't catch out exceptions.
    app.testing = True

    # Create a test client.
    client = app.test_client()

    # Fetch the index page.
    check_code(client, '/')

    # Get the V4 overview page.
    check_code(client, '/v4/nts/')

    # Get a machine overview page.
    check_code(client, '/v4/nts/machine/1')

    # Check invalid machine gives error.
    check_code(client,  '/v4/nts/machine/1000', expected_code=404)
    # Get a machine overview page in JSON format.
    check_code(client, '/v4/nts/machine/1?json=true')

    # Get the order summary page.
    check_code(client, '/v4/nts/all_orders')

    # Get an order page.
    check_code(client, '/v4/nts/order/3')

    # Get a run result page (and associated views).
    check_code(client, '/v4/nts/1')

    check_code(client, '/v4/nts/1?json=true')

    check_code(client, '/v4/nts/1/report')

    check_code(client, '/v4/nts/1/text_report')


    # Get a graph page. This has been changed to redirect.
    check_redirect(client, '/v4/nts/1/graph?test.87=2',
                   'v4/nts/graph\?plot\.0=1\.87\.2&highlight_run=1$')

    # Get the new graph page.
    check_code(client, '/v4/nts/graph?plot.0=1.87.2')

    # Get the mean graph page.
    check_code(client, '/v4/nts/graph?mean=1.2')

    # Check some variations of the daily report work.
    check_code(client, '/v4/nts/daily_report/2012/4/12')
    check_code(client, '/v4/nts/daily_report/2012/4/11')
    check_code(client, '/v4/nts/daily_report/2012/4/13')
    check_code(client, '/v4/nts/daily_report/2012/4/10')
    check_code(client, '/v4/nts/daily_report/2012/4/14')
    check_redirect(client, '/v4/nts/daily_report',
                   '/v4/nts/daily_report/\d+/\d+/\d+$')
    check_redirect(client, '/v4/nts/daily_report?num_days=7',
                   '/v4/nts/daily_report/\d+/\d+/\d+\?num_days=7$')
    # Don't crash when using a parameter that happens to have the same name as
    # a flask URL variable.
    check_redirect(client, '/v4/nts/daily_report?day=15',
                   '/v4/nts/daily_report/\d+/\d+/\d+$')

    # check ?filter-machine-regex= filter
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12', 3)
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=machine2', 1)
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=machine', 2)
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=ma.*[34]$', 1)
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=ma.*4', 0)
    # Don't crash on an invalid regular expression:
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=?', 3)

    # Now check the compile report
    # Get the V4 overview page.
    check_code(client, '/v4/compile/')

    # Get a machine overview page.
    check_code(client, '/v4/compile/machine/1')
    check_code(client, '/v4/compile/machine/2')

    # Get the order summary page.
    check_code(client, '/v4/compile/all_orders')

    # Get an order page.
    check_code(client, '/v4/compile/order/3')

    # Get a run result page (and associated views).
    check_code(client, '/v4/compile/1')
    check_code(client, '/v4/compile/2')
    check_code(client, '/v4/compile/3')
    check_code(client, '/v4/compile/4')
    check_code(client, '/v4/compile/10', expected_code=404) # This page should not be there.

    check_code(client, '/v4/compile/1/report')

    check_code(client, '/v4/compile/1/text_report')

    # Get the new graph page.
    check_code(client, '/v4/compile/graph?plot.38=2.38.9')

    # Get the mean graph page.
    check_code(client, 'v4/compile/graph?mean=2.9')

    # Check some variations of the daily report work.
    check_code(client, '/v4/compile/daily_report/2014/6/5?day_start=16')
    check_code(client, '/v4/compile/daily_report/2014/6/4')


if __name__ == '__main__':
    main()

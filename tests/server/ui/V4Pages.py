# Perform basic sanity checking of the V4 UI pages.
#
# create temporary instance
# Cleanup temporary directory in case one remained from a previous run - also
# see PR9904.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:   %s %{shared_inputs}/SmallInstance %t.instance \
# RUN:   %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import logging
import re
import sys
import xml.etree.ElementTree as ET
from htmlentitydefs import name2codepoint

import lnt.server.db.migrate
import lnt.server.ui.app
import json

logging.basicConfig(level=logging.DEBUG)

HTTP_BAD_REQUEST = 400
HTTP_NOT_FOUND = 404


def check_code(client, url, expected_code=200, data_to_send=None):
    """Call a flask url, and make sure the return code is good."""
    resp = client.get(url, follow_redirects=False, data=data_to_send)
    assert resp.status_code == expected_code, \
        "Call to %s returned: %d, not the expected %d"%(url, resp.status_code, expected_code)
    return resp


def check_json(client, url, expected_code=200, data_to_send=None):
    """Call a flask url, make sure the return code is good,
    and grab reply data from the json payload."""
    return json.loads(check_code(client, url, expected_code,
                      data_to_send=data_to_send).data)


def check_redirect(client, url, expected_redirect_regex):
    """Check the client returns the expected redirect on this URL."""
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


def find_table_with_heading(tree, table_heading):
    table_parent_elements = tree.findall(".//table/..")
    found_header = False
    for parent in table_parent_elements:
        for child in parent.findall('*'):
            if found_header:
                if child.tag == "table":
                    return child
            elif (child.tag.startswith('h') and
                  child.text == table_heading):
                found_header = True
    return None


def check_nr_machines_reported(client, url, expected_nr_machines):
    resp = check_code(client, url)
    html = resp.data
    tree = get_xml_tree(html)
    # look for the table containing the machines on the page.
    # do this by looking for the title containing "Reported Machine Order"
    # and assuming that the first <table> at the same level after it is the
    # one we're looking for.
    reported_machine_order_table = \
        find_table_with_heading(tree, 'Reported Machine Order')
    if reported_machine_order_table is None:
        nr_machines = 0
    else:
        nr_machines = len(reported_machine_order_table.findall("./tbody/tr"))
    assert expected_nr_machines == nr_machines


def convert_html_to_text(element):
    return ("".join(element.itertext()))


def get_table_by_header(client, url, table_header):
    resp = check_code(client, url)
    html = resp.data
    tree = get_xml_tree(html)
    table = find_table_with_heading(tree, table_header)
    assert table is not None, \
        "Couldn't find table with header '%s'" % table_header
    return table


def get_results_table(client, url, fieldname):
    table_header = "Result Table (%s)" % fieldname
    return get_table_by_header(client, url, table_header)


def check_table_content(table, expected_content):
    body_content = [[convert_html_to_text(cell).strip()
                     for cell in row.findall("./td")]
                    for row in table.findall("./tbody/tr")]
    assert expected_content == body_content, \
        "Expected table content %s, found %s" % \
        (expected_content, body_content)


def check_body_result_table(client, url, fieldname, expected_content):
    table = get_results_table(client, url, fieldname)
    check_table_content(table, expected_content)


def check_body_nr_tests_table(client, url, expected_content):
    table_header = "Number of Tests Seen"
    table = get_table_by_header(client, url, table_header)
    check_table_content(table, expected_content)


def get_sparkline(table, testname, machinename):
    body_content = [[cell
                     for cell in row.findall("./td")]
                    for row in table.findall("./tbody/tr")]
    txt_body_content = [[convert_html_to_text(cell).strip()
                         for cell in row.findall("./td")]
                        for row in table.findall("./tbody/tr")]
    cur_test_name = ""
    for rownr, row_content in enumerate(txt_body_content):
        for colnr, col_content in enumerate(row_content):
            if colnr == 0 and col_content != "":
                cur_test_name = col_content
            if colnr == 1 and col_content != "":
                cur_machine_name = machinename
                if (cur_machine_name, cur_test_name) == \
                   (machinename, testname):
                    return body_content[rownr][-1]
    return None


def extract_sample_points(sparkline_svg):
    # assume all svg:circle elements are exactly all the sample points
    samples = sparkline_svg.findall(".//circle")
    return samples


fillStyleRegex = re.compile("fill: *(?P<fill>[^;]+);")


def extract_background_colors(sparkline_svg, nr_days):
    rects = sparkline_svg.findall(".//rect")
    # The first rectangle returned is the default background, so remove that
    # one.
    assert len(rects) >= 1
    rects = rects[1:]
    result = []
    for rect in rects:
        style = rect.get("style", None)
        if style is None:
            result.append(None)
            continue
        m = fillStyleRegex.search(style)
        if m is None:
            result.append(None)
            continue
        fill = m.group('fill')
        if fill == 'none':
            result.append(None)
        else:
            result.append(fill)
    return result


def main():
    _, instance_path = sys.argv

    # Create the application instance.
    app = lnt.server.ui.app.App.create_standalone(instance_path)

    # Don't catch out exceptions.
    app.testing = True

    # Create a test client.
    client = app.test_client()

    # Fetch the index page.
    check_code(client, '/')
    
    # Rules the index page.
    check_code(client, '/rules')

    # Get the V4 overview page.
    check_code(client, '/v4/nts/')

    # Get a machine overview page.
    check_code(client, '/v4/nts/machine/1')
    # Check invalid machine gives error.
    check_code(client,  '/v4/nts/machine/9999', expected_code=HTTP_NOT_FOUND)
    # Get a machine overview page in JSON format.
    check_code(client, '/v4/nts/machine/1?json=true')

    # Get the order summary page.
    check_code(client, '/v4/nts/all_orders')

    # Get an order page.
    check_code(client, '/v4/nts/order/3')
    # Check invalid order gives error.
    check_code(client, '/v4/nts/order/9999', expected_code=HTTP_NOT_FOUND)

    # Get a run result page (and associated views).
    check_code(client, '/v4/nts/1')
    check_code(client, '/v4/nts/1?json=true')
    check_code(client, '/v4/nts/1/report')
    check_code(client, '/v4/nts/1/text_report')
    # Check invalid run numbers give errors.
    check_code(client, '/v4/nts/9999',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/nts/9999?json=true',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/nts/9999/report',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/nts/9999/text_report',
               expected_code=HTTP_NOT_FOUND)

    # Get a graph page. This has been changed to redirect.
    check_redirect(client, '/v4/nts/1/graph?test.3=2',
                   'v4/nts/graph\?plot\.0=1\.3\.2&highlight_run=1$')

    # Get the new graph page.
    check_code(client, '/v4/nts/graph?plot.0=1.3.2')
    # Don't crash when requesting non-existing data
    check_code(client, '/v4/nts/graph?plot.9999=1.3.2')
    check_code(client, '/v4/nts/graph?plot.0=9999.3.2',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/nts/graph?plot.0=1.9999.2',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/nts/graph?plot.0=1.3.9999',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/nts/graph?plot.9999=1.3.2&json=True')
    # Get the mean graph page.
    check_code(client, '/v4/nts/graph?mean=1.2')
    # Don't crash when requesting non-existing data
    check_code(client, '/v4/nts/graph?mean=9999.2',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/nts/graph?mean=1.9999',
               expected_code=HTTP_NOT_FOUND)

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
    # Don't crash when requesting non-existing data
    check_code(client, '/v4/nts/daily_report/1999/4/12')
    check_code(client, '/v4/nts/daily_report/-1/4/12',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/nts/daily_report/2012/13/12',
               expected_code=HTTP_BAD_REQUEST)
    check_code(client, '/v4/nts/daily_report/2012/4/32',
               expected_code=HTTP_BAD_REQUEST)

    # check ?filter-machine-regex= filter
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12', 3)
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=machine2', 1)
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=machine', 2)
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=ma.*[34]$', 1)
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=ma.*4', 0)
    # Don't crash on an invalid regular expression:
    # FIXME - this should probably return HTTP_BAD_REQUEST instead of silently
    # ignoring the invalid regex.
    check_nr_machines_reported(client, '/v4/nts/daily_report/2012/4/12?filter-machine-regex=?', 3)

    # check that a regression seen between 2 consecutive runs that are
    # more than a day apart gets reported
    result_table_20120504 = get_results_table(
        client, '/v4/nts/daily_report/2012/5/04', "execution_time")
    check_table_content(result_table_20120504,
                        [["test1", ""],
                         ["", "machine2", "1.0000", "-", "900.00%", ""],
                         ["test2", ""],
                         ["", "machine2", "FAIL", "-", "PASS", ""]])

    check_body_nr_tests_table(
        client, '/v4/nts/daily_report/2012/5/04',
        [['machine2', '2', '0', '1']])

    # Check that a failing result does not show up in the spark line
    # as a dot with value 0.
    result_table_20120513 = get_results_table(
        client, '/v4/nts/daily_report/2012/5/13?num_days=3', "execution_time")
    check_table_content(result_table_20120513,
                        [["test6", ""],
                         ["", "machine2", "1.0000", "FAIL", "PASS", ""],
                         ["test_hash1", ""],
                         ["", "machine2", "1.0000", '-', '20.00%', ""],
                         ["test_hash2", ""],
                         ["", "machine2", "1.0000", '-', '20.00%', ""],
                         ["test_mhash_on_run", ""],
                         ["", "machine2", "1.0000", '-', '20.00%', ""], ])

    sparkline_test6_xml = \
        get_sparkline(result_table_20120513, "test6", "machine2")
    nr_sample_points = len(extract_sample_points(sparkline_test6_xml))
    assert 2 == nr_sample_points, \
        "Expected 2 sample points, found %d" % nr_sample_points

    # Check that a different background color is used in the sparkline
    # when the hash values recorded are different. At the same time,
    # check that no background color is drawn on missing hash values,
    # using a sequence of (hash1, no hash, hash2) over 3 consecutive
    # days.
    sparkline_hash1_xml = \
        get_sparkline(result_table_20120513, "test_hash1", "machine2")
    nr_sample_points = len(extract_sample_points(sparkline_hash1_xml))
    assert 3 == nr_sample_points, \
        "Expected 3 sample points, found %d" % nr_sample_points
    background_colors = extract_background_colors(sparkline_hash1_xml, 3)
    assert len(background_colors) == 3
    color1, color2, color3 = background_colors
    assert color1 is not None
    assert color3 is not None
    assert color1 != color3
    assert color2 is None

    # Check that the same background color is used in the sparkline
    # when the hash values recorded are the same, using a
    # (hash1, hash2, hash1) sequence.
    sparkline_hash2_xml = \
        get_sparkline(result_table_20120513, "test_hash2", "machine2")
    nr_sample_points = len(extract_sample_points(sparkline_hash2_xml))
    assert 3 == nr_sample_points, \
        "Expected 3 sample points, found %d" % nr_sample_points
    background_colors = extract_background_colors(sparkline_hash2_xml, 3)
    assert len(background_colors) == 3
    color1, color2, color3 = background_colors
    assert color1 is not None
    assert color1 == color3
    assert color1 != color2
    assert color2 is not None

    # Check that we don't crash if a single run produces multiple
    # samples with different hash values for the same run. This could
    # happen e.g. when the compiler under test doesn't produce
    # object code deterministically.
    sparkline_mhashonrun_xml = get_sparkline(
        result_table_20120513, "test_mhash_on_run", "machine2")
    nr_sample_points = len(extract_sample_points(sparkline_mhashonrun_xml))
    assert 4 == nr_sample_points, \
        "Expected 4 sample points, found %d" % nr_sample_points
    background_colors = extract_background_colors(sparkline_mhashonrun_xml, 3)
    assert len(background_colors) == 3
    color1, color2, color3 = background_colors
    assert color2 is None
    assert color1 != color3

    # Now check the compile report
    # Get the V4 overview page.
    check_code(client, '/v4/compile/')

    # Get a machine overview page.
    check_code(client, '/v4/compile/machine/1')
    check_code(client, '/v4/compile/machine/2')
    # Don't crash when requesting non-existing data
    check_code(client, '/v4/compile/machine/9999',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/compile/machine/-1', expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/compile/machine/a', expected_code=HTTP_NOT_FOUND)

    # Get the order summary page.
    check_code(client, '/v4/compile/all_orders')

    # Get an order page.
    check_code(client, '/v4/compile/order/3')

    # Get a run result page (and associated views).
    check_code(client, '/v4/compile/1')
    check_code(client, '/v4/compile/2')
    check_code(client, '/v4/compile/3')
    check_code(client, '/v4/compile/4')
    check_code(client, '/v4/compile/9999', expected_code=HTTP_NOT_FOUND)

    check_code(client, '/v4/compile/1/report')

    check_code(client, '/v4/compile/1/text_report')

    # Get the new graph page.
    check_code(client, '/v4/compile/graph?plot.3=2.3.9')

    # Get the mean graph page.
    check_code(client, 'v4/compile/graph?mean=2.9')

    # Check some variations of the daily report work.
    check_code(client, '/v4/compile/daily_report/2014/6/5?day_start=16')
    check_code(client, '/v4/compile/daily_report/2014/6/4')
    
    check_redirect(client, '/v4/nts/regressions/new_from_graph/1/1/1/1', '/v4/nts/regressions/1')
    check_code(client, '/v4/nts/regressions/')
    
    check_code(client, '/v4/nts/regressions/1')
    
    check_json(client, '/v4/nts/regressions/1?json=True')
    
    


if __name__ == '__main__':
    main()

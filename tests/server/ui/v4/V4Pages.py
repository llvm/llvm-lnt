# Perform basic sanity checking of the V4 UI pages.
#
# create temporary instance
# Cleanup temporary directory in case one remained from a previous run - also
# see PR9904.
# RUN: rm -rf %t.instance
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         %{shared_inputs}/base-reports \
# RUN:         %{shared_inputs}/extra-reports \
# RUN:         %{shared_inputs}/profile-report.json \
# RUN:         %S/Inputs/last-run-report.json \
# RUN:         %S/Inputs/sample-failed-report1.json \
# RUN:         %S/Inputs/sample-failed-report2.json \
# RUN:         -- python %s %t.instance %{tidylib}

import logging
import re
import sys
import xml.etree.ElementTree as ET
from html.entities import name2codepoint
from flask import session
import lnt.server.db.migrate
import lnt.server.ui.app
import json

# We can validate html if pytidylib is available and tidy-html5 is installed.
# The user can indicate this by passing --use-tidylib to the script (triggered
# by `lit -Dtidylib=1`)
if '--use-tidylib' in sys.argv:
    import tidylib

    def validate_html(text):
        document, errors = tidylib.tidy_document(text)
        had_error = False
        ignore = [
            "Warning: trimming empty",
            "Warning: inserting implicit",
        ]
        for e in errors.splitlines():
            ignore_line = False
            for i in ignore:
                if i in e:
                    ignore_line = True
                    break
            if ignore_line:
                continue
            sys.stderr.write(e + '\n')
            had_error = True
        if had_error:
            with open('/tmp/lntpage.html', 'w') as out:
                out.write(text)
            sys.stderr.write("Note: html saved in /tmp/lntpage.html\n")
        assert not had_error
else:
    def validate_html(text):
        pass

logging.basicConfig(level=logging.DEBUG)

HTTP_BAD_REQUEST = 400
HTTP_NOT_FOUND = 404
HTTP_REDIRECT = 302
HTTP_OK = 200


def check_code(client, url, expected_code=HTTP_OK, data_to_send=None):
    """Call a flask url, and make sure the return code is good."""
    resp = client.get(url, follow_redirects=False, data=data_to_send)
    assert resp.status_code == expected_code, \
        "Call to %s returned: %d, not the expected %d" % (url, resp.status_code,
                                                          expected_code)
    return resp


def check_html(client, url, expected_code=HTTP_OK, data_to_send=None):
    resp = check_code(client, url, expected_code, data_to_send)
    validate_html(resp.get_data(as_text=True))
    return resp


def check_json(client, url, expected_code=HTTP_OK, data_to_send=None):
    """Call a flask url, make sure the return code is good,
    and grab reply data from the json payload."""
    return json.loads(check_code(client, url, expected_code,
                      data_to_send=data_to_send).data)


def check_redirect(client, url, expected_redirect_regex):
    """Check the client returns the expected redirect on this URL."""
    resp = client.get(url, follow_redirects=False)
    assert resp.status_code == HTTP_REDIRECT, \
        "Call to %s returned: %d, not the expected %d" % (url, resp.status_code,
                                                          HTTP_REDIRECT)
    regex = re.compile(expected_redirect_regex)
    assert regex.search(resp.location), \
        "Call to %s redirects to: %s, not matching the expected regex %s" \
        % (url, resp.location, expected_redirect_regex)
    return resp


def dump_html(html_string):
    for linenr, line in enumerate(html_string.split('\n')):
        print("%4d:%s" % (linenr + 1, line))


def get_xml_tree(html_string):
    try:
        entities_defs = []
        for x, i in name2codepoint.items():
            entities_defs.append('  <!ENTITY {x} "&#{i};">'.format(**locals()))
        docstring = "<!DOCTYPE html [\n{}\n]>".format('\n'.join(entities_defs))
        html_string = html_string.replace("<!DOCTYPE html>", docstring, 1)
        tree = ET.fromstring(html_string)
    except:  # noqa FIXME: figure out what we expect this to throw.
        dump_html(html_string)
        raise
    return tree


def find_table_by_thead_content(tree, table_head_contents):
    all_tables = tree.findall(".//thead/..")
    for table in all_tables:
        for child in table.findall('./thead/tr/th'):
            if child.text == table_head_contents:
                return table
    return None


def find_table_with_heading(tree, table_heading):
    table_parent_elements = tree.findall(".//table/..")
    found_header = False
    for parent in table_parent_elements:
        for child in parent.findall('*'):
            if found_header:
                if child.tag == "table":
                    return child
            elif child.tag.startswith('h') and child.text == table_heading:
                found_header = True
    return None


def check_nr_machines_reported(client, url, expected_nr_machines):
    resp = check_code(client, url)
    html = resp.get_data(as_text=sys.version_info[0] >= 3)
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
    html = resp.get_data(as_text=sys.version_info[0] >= 3)
    tree = get_xml_tree(html)
    table = find_table_with_heading(tree, table_header)
    assert table is not None, \
        "Couldn't find table with header '%s'" % table_header
    return table


def get_results_table(client, url, fieldname):
    table_header = "Result Table (%s)" % fieldname
    return get_table_by_header(client, url, table_header)


def get_table_body_content(table):
    return [[convert_html_to_text(cell).strip()
             for cell in row.findall("./td")]
            for row in table.findall("./tbody/tr")]


def get_table_links(table):
    return [[link.get("href")
             for cell in row.findall("./td")
             for link in cell.findall("a")]
            for row in table.findall("./tbody/tr")]


def check_row_is_in_table(table, expected_row_content):
    body_content = get_table_body_content(table)
    assert expected_row_content in body_content, \
        "Expected row content %s not found in %s" % \
        (expected_row_content, body_content)


def check_table_content(table, expected_content):
    body_content = get_table_body_content(table)
    assert expected_content == body_content, \
        "Expected table content %s, found %s" % \
        (expected_content, body_content)


def check_table_links(table, expected_content):
    body_content = get_table_links(table)
    assert expected_content == body_content, \
        "Expected table links %s, found %s" % \
        (expected_content, body_content)


def check_body_result_table(client, url, fieldname, expected_content):
    table = get_results_table(client, url, fieldname)
    check_table_content(table, expected_content)


def check_body_nr_tests_table(client, url, expected_content):
    table_header = "Number of Tests Seen"
    table = get_table_by_header(client, url, table_header)
    check_table_content(table, expected_content)


def check_producer_label(client, url, label):
    table_header = "Produced by"
    resp = check_code(client, url)
    tree = get_xml_tree(resp.get_data(as_text=sys.version_info[0] >= 3))
    table = find_table_by_thead_content(tree, table_header)
    check_row_is_in_table(table, label)


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
    instance_path = sys.argv[1]

    # Create the application instance.
    app = lnt.server.ui.app.App.create_standalone(instance_path)

    # Don't catch out exceptions.
    app.testing = True
    app.config['WTF_CSRF_ENABLED'] = False

    # Create a test client.
    client = app.test_client()

    # === Build ID maps for dynamic lookups ===

    # NTS machines
    nts_mj = check_json(client, 'api/db_default/v4/nts/machines/')
    nts_m = {m['name']: m['id'] for m in nts_mj['machines']}
    m1_id = nts_m['localhost__clang_DEV__x86_64']
    m2_id = nts_m['machine2']
    m3_id = nts_m['machine3']
    profile_m_id = nts_m['e105293.local__clang_DEV__x86_64']
    failed_m_id = nts_m['LNT SAMPLE MACHINE']

    # NTS tests
    nts_tj = check_json(client, 'api/db_default/v4/nts/tests')
    nts_t = {t['name']: t['id'] for t in nts_tj['tests']}
    fv_id = nts_t['SingleSource/UnitTests/2006-12-01-float_varg']
    test1_id = nts_t['test1']
    test2_id = nts_t['test2']
    test6_id = nts_t['test6']
    hash1_id = nts_t['test_hash1']
    hash2_id = nts_t['test_hash2']
    mhash_id = nts_t['test_mhash_on_run']
    foo_id = nts_t['foo']

    # NTS machine data and runs keyed by revision
    def runs_by_rev(machine_data):
        return {r.get('llvm_project_revision'): r
                for r in machine_data['runs']
                if r.get('llvm_project_revision')}

    m1_data = check_json(
        client, f'api/db_default/v4/nts/machines/{m1_id}')
    m2_data = check_json(
        client, f'api/db_default/v4/nts/machines/{m2_id}')
    m3_data = check_json(
        client, f'api/db_default/v4/nts/machines/{m3_id}')
    profile_data = check_json(
        client, f'api/db_default/v4/nts/machines/{profile_m_id}')
    failed_data = check_json(
        client, f'api/db_default/v4/nts/machines/{failed_m_id}')

    m1_rbr = runs_by_rev(m1_data)
    m2_rbr = runs_by_rev(m2_data)

    # Key NTS run IDs
    m1_run1_id = m1_rbr['154331']['id']
    reg_run1_id = m2_rbr['152292']['id']
    reg_run2_id = m2_rbr['152293']['id']
    spark_run1_id = m2_rbr['152294']['id']
    spark_run2_id = m2_rbr['152295']['id']
    spark_run3_id = m2_rbr['152296']['id']

    # NTS order ID (from a machine2 run)
    m2_run_detail = check_json(
        client, f"api/db_default/v4/nts/runs/{m2_data['runs'][0]['id']}")
    nts_order_id = m2_run_detail['run']['order_id']

    # Compile machines
    compile_mj = check_json(client, 'api/db_default/v4/compile/machines/')
    compile_m = {m['name']: m['id'] for m in compile_mj['machines']}
    cm1_id = compile_m['localhost']
    cm2_id = compile_m['MacBook-Pro.local']

    cm1_data = check_json(
        client, f'api/db_default/v4/compile/machines/{cm1_id}')
    cm2_data = check_json(
        client, f'api/db_default/v4/compile/machines/{cm2_id}')

    # Compile tests
    compile_tj = check_json(client, 'api/db_default/v4/compile/tests')
    compile_t = {t['name']: t['id'] for t in compile_tj['tests']}

    # Compile order
    cm2_run_detail = check_json(
        client, f"api/db_default/v4/compile/runs/{cm2_data['runs'][0]['id']}")
    compile_order_id = cm2_run_detail['run']['order_id']

    # Get a sample from sparkline-run1 for test6 (used in graph_for_sample)
    spark_run1_samples = check_json(
        client, f'api/db_default/v4/nts/samples?runid={spark_run1_id}')
    test6_sample_id = next(s['id'] for s in spark_run1_samples['samples']
                           if s['name'] == 'test6')

    # === End ID maps ===

    # Fetch the index page.
    check_html(client, '/')

    # Get the V4 overview page.
    check_html(client, '/v4/nts/')

    # Get a machine overview page.
    check_html(client, f'/v4/nts/machine/{m1_id}')
    # Check invalid machine gives error.
    check_code(client, '/v4/nts/machine/9999', expected_code=HTTP_NOT_FOUND)
    # Get a machine overview page in JSON format.
    check_json(client, f'/v4/nts/machine/{m1_id}?json=true')

    # Get the order summary page.
    check_html(client, '/v4/nts/all_orders')

    # Get an order page.
    check_html(client, f'/v4/nts/order/{nts_order_id}')
    # Check invalid order gives error.
    check_code(client, '/v4/nts/order/9999', expected_code=HTTP_NOT_FOUND)

    # Check that we can promote a baseline, then demote.
    form_data = dict(name="foo_baseline",
                     description="foo_descrimport iption",
                     prmote=True)
    r = client.post(f'/v4/nts/order/{nts_order_id}', data=form_data)
    # We should redirect to the last page and flash.
    assert r.status_code == HTTP_REDIRECT

    # Try with redirect.
    r = client.post(f'/v4/nts/order/{nts_order_id}',
                    data=form_data,
                    follow_redirects=True)
    assert r.status_code == HTTP_OK
    # Should see baseline displayed in page body.
    assert "Baseline - foo_baseline" in r.get_data(as_text=True)

    # Set the baseline before demoting (baseline ID 1 is the first created).
    check_code(client, '/v4/nts/set_baseline/1', expected_code=HTTP_REDIRECT)
    with app.test_client() as c:
        c.get('/v4/nts/set_baseline/1')
        session.get('baseline-default-nts') == 1

    # Now demote it.
    data2 = dict(name="foo_baseline",
                 description="foo_description",
                 update=False,
                 promote=False,
                 demote=True)
    r = client.post(f'/v4/nts/order/{nts_order_id}',
                    data=data2, follow_redirects=True)
    assert r.status_code == HTTP_OK
    # Baseline should no longer be shown in page baseline.
    assert "Baseline - foo_baseline" not in r.get_data(as_text=True)

    # Leave a baseline in place for the rest of the tests.
    client.post(f'/v4/nts/order/{nts_order_id}', data=form_data)

    # Get a run result page (and associated views).
    check_html(client, f'/v4/nts/{m1_run1_id}')
    check_json(client, f'/v4/nts/{m1_run1_id}?json=true')
    check_html(client, f'/v4/nts/{m1_run1_id}/report')
    check_code(client, f'/v4/nts/{m1_run1_id}/text_report')
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
    check_redirect(client,
                   f'/v4/nts/{m1_run1_id}/graph?test.{fv_id}=2',
                   rf'v4/nts/graph\?'
                   rf'(plot\.0={m1_id}\.{fv_id}\.2&highlight_run={m1_run1_id}'
                   rf'|highlight_run={m1_run1_id}&plot\.0={m1_id}\.{fv_id}\.2)$')

    # Get a run that contains generic producer information
    check_producer_label(client, f'/v4/nts/{spark_run1_id}',
                         ['Current', '152294', '2012-05-10T16:28:23',
                          '0:00:35', 'Producer'])
    check_producer_label(client, f'/v4/nts/{spark_run2_id}',
                         ['Current', '152295', '2012-05-11T16:28:23',
                          '0:00:35', 'Producer'])

    # Get a run that contains Buildbot producer information
    check_producer_label(client, f'/v4/nts/{reg_run1_id}',
                         ['Current', '152292', '2012-05-01T16:28:23',
                          '0:00:35', 'some-builder #987'])
    check_producer_label(client, f'/v4/nts/{spark_run3_id}',
                         ['Current', '152296', '2012-05-12T16:28:23',
                          '0:00:35', 'some-builder #999'])

    # Get the new graph page.
    check_html(client, f'/v4/nts/graph?plot.0={m1_id}.{fv_id}.2')
    # Don't crash when requesting non-existing data
    check_html(client, f'/v4/nts/graph?plot.9999={m1_id}.{fv_id}.2')
    check_code(client, f'/v4/nts/graph?plot.0=9999.{fv_id}.2',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, f'/v4/nts/graph?plot.0={m1_id}.9999.2',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, f'/v4/nts/graph?plot.0={m1_id}.{fv_id}.9999',
               expected_code=HTTP_NOT_FOUND)
    check_json(client, f'/v4/nts/graph?plot.9999={m1_id}.{fv_id}.2&json=True')
    # Get the mean graph page.
    check_html(client, f'/v4/nts/graph?mean={m1_id}.2')
    # Don't crash when requesting non-existing data
    check_code(client, '/v4/nts/graph?mean=9999.2',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, f'/v4/nts/graph?mean={m1_id}.9999',
               expected_code=HTTP_NOT_FOUND)
    #  Check baselines work.
    check_html(client, f'/v4/nts/graph?plot.0={m1_id}.{fv_id}.2&baseline.60={m1_run1_id}')

    # Check some variations of the daily report work.
    check_html(client, '/v4/nts/daily_report/2012/4/12')
    check_html(client, '/v4/nts/daily_report/2012/4/11')
    check_html(client, '/v4/nts/daily_report/2012/4/13')
    check_html(client, '/v4/nts/daily_report/2012/4/10')
    check_html(client, '/v4/nts/daily_report/2012/4/14')
    check_redirect(client, '/v4/nts/daily_report',
                   r'/v4/nts/daily_report/\d+/\d+/\d+$')
    check_redirect(client, '/v4/nts/daily_report?num_days=7',
                   r'/v4/nts/daily_report/\d+/\d+/\d+\?num_days=7$')
    # Don't crash when using a parameter that happens to have the same name as
    # a flask URL variable.
    check_redirect(client, '/v4/nts/daily_report?day=15',
                   r'/v4/nts/daily_report/\d+/\d+/\d+$')
    # Don't crash when requesting non-existing data
    check_html(client, '/v4/nts/daily_report/1999/4/12')
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
        client, '/v4/nts/daily_report/2012/5/04', "Execution Time")
    check_table_content(result_table_20120504,
                        [["test1", ""],
                         ["", "machine2", "1.000", "-", "10.000", ""],
                         ["test2", ""],
                         ["", "machine2", "FAIL", "-", "-", ""]])
    check_table_links(result_table_20120504,
                      [[],
                       [f"/db_default/v4/nts/graph?plot.0={m2_id}.{test1_id}.2&highlight_run={reg_run2_id}"],
                       [],
                       [f"/db_default/v4/nts/graph?plot.0={m2_id}.{test2_id}.2&highlight_run={reg_run2_id}"]])

    check_body_nr_tests_table(
        client, '/v4/nts/daily_report/2012/5/04',
        [['machine2', '2', '0', '1']])

    # Check that a failing result does not show up in the spark line
    # as a dot with value 0.
    result_table_20120513 = get_results_table(
        client, '/v4/nts/daily_report/2012/5/13?num_days=3', "Execution Time")
    check_table_content(result_table_20120513,
                        [["test6", ""],
                         ["", "machine2", "1.000", "FAIL", "1.200", ""],
                         ["test_hash1", ""],
                         ["", "machine2", "1.000", '1.000', '1.200', ""],
                         ["test_hash2", ""],
                         ["", "machine2", "1.000", '1.000', '1.200', ""],
                         ["test_mhash_on_run", ""],
                         ["", "machine2", "1.000", '1.000', '1.200', ""], ])
    check_table_links(result_table_20120513,
                      [[],
                       [f'/db_default/v4/nts/graph?plot.0={m2_id}.{test6_id}.2&highlight_run={spark_run3_id}'],
                       [],
                       [f'/db_default/v4/nts/graph?plot.0={m2_id}.{hash1_id}.2&highlight_run={spark_run3_id}'],
                       [],
                       [f'/db_default/v4/nts/graph?plot.0={m2_id}.{hash2_id}.2&highlight_run={spark_run3_id}'],
                       [],
                       [f'/db_default/v4/nts/graph?plot.0={m2_id}.{mhash_id}.2&highlight_run={spark_run3_id}']])

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

    # Check some variations of the latest runs report work.
    check_html(client, '/v4/nts/latest_runs_report')

    check_redirect(client, '/db_default/submitRun',
                   '/db_default/v4/nts/submitRun')
    check_html(client, '/db_default/v4/nts/submitRun')

    check_html(client, '/v4/nts/global_status')

    check_html(client, '/v4/nts/recent_activity')

    # Now check the compile report
    # Get the V4 overview page.
    check_html(client, '/v4/compile/')

    # Get a machine overview page.
    check_html(client, f'/v4/compile/machine/{cm1_id}')
    check_html(client, f'/v4/compile/machine/{cm2_id}')
    check_code(client, f'/v4/compile/machine/{cm2_id}/latest',
               expected_code=HTTP_REDIRECT)
    # Don't crash when requesting non-existing data
    check_code(client, '/v4/compile/machine/9999',
               expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/compile/machine/-1', expected_code=HTTP_NOT_FOUND)
    check_code(client, '/v4/compile/machine/a', expected_code=HTTP_NOT_FOUND)

    # Check the compare machine form gives correct redirects.
    m2_latest = max(r['id'] for r in m2_data['runs'])
    m3_latest = max(r['id'] for r in m3_data['runs'])
    resp = check_code(
        client,
        f'/v4/nts/machine/{m2_id}/compare?compare_to_id={m3_id}',
        expected_code=HTTP_REDIRECT)
    assert resp.headers['Location'] == \
        f"/db_default/v4/nts/{m2_latest}?compare_to={m3_latest}"
    resp = check_code(
        client,
        f'/v4/nts/machine/{m3_id}/compare?compare_to_id={m2_id}',
        expected_code=HTTP_REDIRECT)
    assert resp.headers['Location'] == \
        f"/db_default/v4/nts/{m3_latest}?compare_to={m2_latest}"

    # Get the order summary page.
    check_html(client, '/v4/compile/all_orders')

    # Get an order page.
    check_html(client, f'/v4/compile/order/{compile_order_id}')

    # Get a run result page (and associated views).
    all_compile_runs = sorted(set(
        r['id'] for r in cm1_data['runs'] + cm2_data['runs']))
    for run_id in all_compile_runs:
        check_html(client, f'/v4/compile/{run_id}')
    check_code(client, '/v4/compile/9999', expected_code=HTTP_NOT_FOUND)

    first_compile_run = cm1_data['runs'][0]['id']
    check_html(client, f'/v4/compile/{first_compile_run}/report')

    check_code(client, f'/v4/compile/{first_compile_run}/text_report')

    # Get the new graph page.
    compile_test_id = compile_t['compile/403.gcc/combine.c/init/(-O0)']
    check_html(client, f'/v4/compile/graph?plot.3={cm2_id}.{compile_test_id}.9')

    # Get the mean graph page.
    check_html(client, f'v4/compile/graph?mean={cm2_id}.9')

    # Check some variations of the daily report work.
    check_html(client, '/v4/compile/daily_report/2014/6/5?day_start=16')
    check_html(client, '/v4/compile/daily_report/2014/6/4')

    new_from_graph_url = f'/v4/nts/regressions/new_from_graph/{m1_id}/{fv_id}/1/{m1_run1_id}'
    regressions_resp = check_redirect(client, new_from_graph_url,
                                      r'/v4/nts/regressions/\d+')
    regression_url = regressions_resp.headers['Location']
    check_html(client, '/v4/nts/regressions/')
    check_html(client, '/v4/nts/regressions/?machine_filter=machine2')
    check_html(client, '/v4/nts/regressions/?machine_filter=machine0')

    check_html(client, regression_url)
    check_json(client, regression_url + '?json=True')

    # Check 404 is issues for inexistent Code
    check_code(client, 'v4/nts/profile/9999/9999', expected_code=HTTP_NOT_FOUND)

    # Profile Viewer Ajax functions
    # Check profiles page is responsive with expected IDs
    profile_run_id = profile_data['runs'][0]['id']
    check_code(client, f'v4/nts/profile/{profile_run_id}/{foo_id}')
    # Check ajax call
    functions = check_json(
        client,
        f'v4/nts/profile/ajax/getFunctions?runid={profile_run_id}&testid={foo_id}')
    number_of_functions = len(functions)
    first_function_name = functions[0][0]
    assert 1 == number_of_functions
    assert "fn1" == first_function_name

    top_level_counters = check_json(
        client,
        f'v4/nts/profile/ajax/getTopLevelCounters?runids={profile_run_id}&testid={foo_id}')
    assert "cycles" in top_level_counters
    assert "branch-misses" in top_level_counters

    code_for_fn = check_json(
        client,
        f'v4/nts/profile/ajax/getCodeForFunction?runid={profile_run_id}&testid={foo_id}&f=fn1')
    lines_in_function = len(code_for_fn)
    assert 2 == lines_in_function

    # Test with various aggregation functions
    agg_plot = f'{m2_id}.{hash1_id}.2'
    for fn in ['mean', 'median', 'min', 'max']:
        agg_url = f'/db_default/v4/nts/graph?aggregation_function={fn}&plot.7.2={agg_plot}'
        check_html(client, agg_url)
        check_json(client, agg_url + '&json=true')
    check_html(client,
               f'/db_default/v4/nts/graph?aggregation_function=nonexistent&plot.7.2={agg_plot}',
               expected_code=404)
    app.testing = False
    error_page = check_html(client, '/explode', expected_code=500)
    assert re.search("InternalServerError", error_page.get_data(as_text=True))

    error_page = check_html(client, '/gone', expected_code=404)
    assert "test" in error_page.get_data(as_text=True)

    check_html(client, '/sleep?timeout=0', expected_code=200)

    check_html(client, '/db_default/summary_report')

    check_html(client, '/rules')
    resp = check_code(client, '/__health')
    assert resp.get_data(as_text=True) == "Ok"
    resp = check_code(client, '/ping')
    assert resp.get_data(as_text=True) == "pong"

    # Check we can convert a sample into a graph page.
    expected_plot = f'{m2_id}.{test6_id}.0'
    graph_to_sample = check_code(
        client,
        f'/db_default/v4/nts/graph_for_sample/{test6_sample_id}/compile_time?foo=bar',
        expected_code=HTTP_REDIRECT)
    assert graph_to_sample.headers['Location'] in (
        f"/db_default/v4/nts/graph?foo=bar&plot.0={expected_plot}",
        f"/db_default/v4/nts/graph?plot.0={expected_plot}&foo=bar")

    # Check that is we ask for a sample or invalid field, we explode with 400s.
    check_code(client, '/db_default/v4/nts/graph_for_sample/10000/compile_time?foo=bar',
               expected_code=HTTP_NOT_FOUND)
    check_code(
        client,
        f'/db_default/v4/nts/graph_for_sample/{test6_sample_id}/not_a_metric?foo=bar',
        expected_code=HTTP_BAD_REQUEST)

    # check get_geomean_comparison_result with empty unchanged_tests
    profile_last_run = max(profile_data['runs'],
                           key=lambda r: r.get('llvm_project_revision', ''))
    failed_run = failed_data['runs'][0]
    check_html(client, f'/v4/nts/{profile_last_run["id"]}')
    check_html(client, f'/v4/nts/{failed_run["id"]}')


if __name__ == '__main__':
    main()

# Perform basic sanity checking of the V4 UI pages. Currently this really only
# checks that we don't crash on any of them.
#
# RUN: python %s %{shared_inputs}/SmallInstance

import logging
import sys

import lnt.server.db.migrate
import lnt.server.ui.app

logging.basicConfig(level=logging.DEBUG)


def check_code(client, url, expected_code=200):
    resp = client.get(url, follow_redirects=False)
    assert resp.status_code == expected_code, \
        "Call to %s returned: %d, not the expected %d"%(url, resp.status_code, expected_code)

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

    # Get the order summary page.
    check_code(client, '/v4/nts/all_orders')

    # Get an order page.
    check_code(client, '/v4/nts/order/3')

    # Get a run result page (and associated views).
    check_code(client, '/v4/nts/1')

    check_code(client, '/v4/nts/1/report')

    check_code(client, '/v4/nts/1/text_report')


    # Get a graph page. This has been changed to redirect.
    check_code(client, '/v4/nts/1/graph?test.87=2', expected_code=302)

    # Get the new graph page.
    check_code(client, '/v4/nts/graph?plot.0=1.87.2')

    # Check some variations of the daily report work.
    check_code(client, '/v4/nts/daily_report/2012/4/12')
    check_code(client, '/v4/nts/daily_report/2012/4/11')
    check_code(client, '/v4/nts/daily_report/2012/4/13')
    check_code(client, '/v4/nts/daily_report/2012/4/10')
    check_code(client, '/v4/nts/daily_report/2012/4/14')

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

    # Check some variations of the daily report work.
    check_code(client, '/v4/compile/daily_report/2014/6/5?day_start=16')
    check_code(client, '/v4/compile/daily_report/2014/6/4')


if __name__ == '__main__':
    main()

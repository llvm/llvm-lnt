# Perform basic sanity checking of the V4 UI pages. Currently this really only
# checks that we don't crash on any of them.
#
# RUN: python %s %{shared_inputs}/SmallInstance

import logging
import sys
import tempfile

import lnt.server.db.migrate
import lnt.server.ui.app

logging.basicConfig(level=logging.DEBUG)

def main():
    _,instance_path = sys.argv

    # Create the application instance.
    app = lnt.server.ui.app.App.create_standalone(instance_path)

    # Create a test client.
    client = app.test_client()

    # Fetch the index page.
    index = client.get('/')

    # Fetch the index page.
    resp = client.get('/')
    assert resp.status_code == 200

    # Get the V4 overview page.
    resp = client.get('/v4/nts/')
    assert resp.status_code == 200

    # Get a machine overview page.
    resp = client.get('/v4/nts/machine/1')
    assert resp.status_code == 200

    # Get the order summary page.
    resp = client.get('/v4/nts/all_orders')
    assert resp.status_code == 200

    # Get an order page.
    resp = client.get('/v4/nts/order/3')
    assert resp.status_code == 200

    # Get a run result page (and associated views).
    resp = client.get('/v4/nts/1')
    assert resp.status_code == 200
    resp = client.get('/v4/nts/1/report')
    assert resp.status_code == 200
    resp = client.get('/v4/nts/1/text_report')
    assert resp.status_code == 200

    # Get a graph page.
    resp = client.get('/v4/nts/1/graph?test.87=2')
    assert resp.status_code == 200

if __name__ == '__main__':
    main()

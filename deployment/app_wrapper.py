"""This file is used to launch LNT inside a gunicorn webserver.

This can be used for deploying on the cloud.
"""

import lnt.server.ui.app

app = lnt.server.ui.app.App.create_standalone('lnt.cfg')

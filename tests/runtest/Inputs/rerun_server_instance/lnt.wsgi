#!/venv/lnt-v0.4/bin/python
# -*- Python -*-

import lnt.server.ui.app

application = lnt.server.ui.app.App.create_standalone(
  '/Users/ddunbar/lnt/tests/server/db/migrate/Inputs/lnt_v0.4.0_filled_instance/lnt.cfg')

if __name__ == "__main__":
    import werkzeug
    werkzeug.run_simple('localhost', 8000, application)

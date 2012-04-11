#!/venv/lnt/bin/python
# -*- Python -*-

import lnt.server.ui.app

application = lnt.server.ui.app.App.create_standalone(
  '/Users/ddunbar/lnt/tests/SharedInputs/test-instance/lnt.cfg')

if __name__ == "__main__":
    import werkzeug
    werkzeug.run_simple('localhost', 8000, application)

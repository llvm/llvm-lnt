from . import upgrade_0_to_1
from . import upgrade_2_to_3
from . import upgrade_7_to_8
from . import upgrade_8_to_9


def init_new_testsuite(engine, session, name):
    """When all the metadata fields are setup for a suite, call this
    to provision the tables."""
    # We only need to do the test-suite agnostic upgrades,
    # most of the upgrades target nts or compile only.
    upgrade_0_to_1.initialize_testsuite(engine, session, name)
    session.commit()
    upgrade_2_to_3.upgrade_testsuite(engine, session, name)
    session.commit()
    upgrade_7_to_8.upgrade_testsuite(engine, session, name)
    session.commit()
    upgrade_8_to_9.upgrade_testsuite(engine, session, name)
    session.commit()

"""Endpoint registration for the v5 API.

``register_all_endpoints()`` imports and registers all endpoint blueprints.
Missing modules are handled gracefully (with a warning) so the app works
during incremental development.
"""

import logging

logger = logging.getLogger(__name__)

# All endpoint modules that should be registered. Each entry is the
# sub-module name relative to ``lnt.server.api.v5.endpoints``.
_ENDPOINT_MODULES = [
    'discovery',
    'test_suites',
    'machines',
    'orders',
    'runs',
    'tests',
    'samples',
    'profiles',
    'regressions',
    'field_changes',
    'query',
    'trends',
    'admin',
]


def register_all_endpoints(smorest_api):
    """Import and register every endpoint blueprint with the Api instance.

    Endpoint modules must expose a ``blp`` attribute which is a
    ``flask_smorest.Blueprint`` instance.
    """
    import importlib

    for module_name in _ENDPOINT_MODULES:
        fqn = 'lnt.server.api.v5.endpoints.%s' % module_name
        try:
            mod = importlib.import_module(fqn)
            blp = getattr(mod, 'blp', None)
            if blp is not None:
                smorest_api.register_blueprint(blp)
            else:
                logger.debug("Module %s has no 'blp' attribute, skipping.",
                             fqn)
        except ImportError:
            logger.debug("Endpoint module %s not yet implemented, skipping.",
                         fqn)
        except Exception:
            logger.warning("Failed to register endpoint module %s:",
                           fqn, exc_info=True)

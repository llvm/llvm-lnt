import plistlib


def _matches_format(path_or_file):
    try:
        plistlib.load(path_or_file)
        return True
    except Exception:
        return False


format = {
    'name': 'plist',
    'predicate': _matches_format,
    'read': plistlib.load,
    'write': plistlib.dump,
}

import plistlib


def _matches_format(path_or_file):
    try:
        if isinstance(path_or_file, str):
            with open(path_or_file, 'rb') as fp:
                plistlib.load(fp)
        else:
            plistlib.load(path_or_file)
        return True
    except Exception:
        return False


def _load_format(path_or_file):
    if isinstance(path_or_file, str):
        with open(path_or_file, 'rb') as fp:
            return plistlib.load(fp)
    else:
        return plistlib.load(path_or_file)


format = {
    'name': 'plist',
    'predicate': _matches_format,
    'read': _load_format,
    'write': plistlib.dump,
}

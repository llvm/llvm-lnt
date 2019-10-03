import json


def _matches_format(path_or_file):
    if isinstance(path_or_file, str):
        path_or_file = open(path_or_file)

    try:
        json.load(path_or_file)
        return True
    except Exception:
        return False


def _load_format(path_or_file):
    if isinstance(path_or_file, str):
        path_or_file = open(path_or_file)

    return json.load(path_or_file)


def _dump_format(obj, fp):
    # The json module produces str objects but fp is opened in binary mode
    # (since Plistlib only dump to binary mode files) so we first dump into
    # a string a convert to UTF-8 before outputing.
    json_str = json.dumps(obj)
    fp.write(json_str.encode())


format = {
    'name': 'json',
    'predicate': _matches_format,
    'read': _load_format,
    'write': _dump_format,
}

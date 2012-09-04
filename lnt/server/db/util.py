
import re

PATH_DATABASE_TYPE_RE = re.compile('\w+\:\/\/')

def path_has_no_database_type(path):
    return PATH_DATABASE_TYPE_RE.match(path) is None

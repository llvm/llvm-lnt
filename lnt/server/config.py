"""
LNT Config object for tracking user-configurable installation parameters.
"""

import os
import re

import lnt.server.db.v4db

class EmailConfig:
    @staticmethod
    def fromData(data):
        # The email to field can either be a string, or a list of tuples of
        # the form [(accept-regexp-pattern, to-address)].
        to_address = data.get('to')
        if not isinstance(to_address, str):
            to_address = [(str(a),str(b)) for a,b in to_address]
        return EmailConfig(bool(data.get('enabled')), str(data.get('host')),
                           str(data.get('from')), to_address)
        
    def __init__(self, enabled, host, from_address, to_address):
        self.enabled = enabled
        self.host = host
        self.from_address = from_address
        self.to_address = to_address

    def get_to_address(self, machine_name):
        # The email to_address field can either be a string, or a list of tuples
        # of the form [(accept-regexp-pattern, to-address)].
        if isinstance(self.to_address, str):
            return self.to_address

        for pattern,addr in self.to_address:
            if re.match(pattern, machine_name):
                return addr

class DBInfo:
    @staticmethod
    def fromData(baseDir, dict, default_email_config):
        dbPath = dict.get('path')

        # If the path does not contain a database specifier, assume it is a
        # relative path.
        if '://' not in dbPath:
            dbPath = os.path.join(baseDir, dbPath)

        # If the path contains a relative SQLite specifier, make it absolute
        # relative to the base dir.
        if dbPath.startswith("sqlite:///") and not \
                dbPath.startswith("sqlite:////"):
            dbPath = "sqlite:///%s" % os.path.join(baseDir,
                                                   dbPath[len("sqlite:///"):])

        # Support per-database email configurations.
        email_config = default_email_config
        if 'emailer' in dict:
            email_config = EmailConfig.fromData(dict['emailer'])

        return DBInfo(dbPath,
                      str(dict.get('db_version', '0.4')),
                      dict.get('shadow_import', None),
                      email_config)

    def __init__(self, path,
                 db_version, shadow_import, email_config):
        self.config = None
        self.path = path
        self.db_version = db_version
        self.shadow_import = shadow_import
        self.email_config = email_config

class Config:
    @staticmethod
    def fromData(path, data):
        # Paths are resolved relative to the absolute real path of the
        # config file.
        baseDir = os.path.dirname(os.path.abspath(path))

        # Get the default email config.
        emailer = data.get('nt_emailer')
        if emailer:
            default_email_config = EmailConfig.fromData(emailer)
        else:
            default_email_config = EmailConfig(False, '', '', [])

        dbDir = data.get('db_dir', '.')
        dbDirPath = os.path.join(baseDir, dbDir)

        # FIXME: Remove this default.
        tempDir = data.get('tmp_dir', 'viewer/resources/graphs')

        secretKey = data.get('secret_key', None)

        return Config(data.get('name', 'LNT'), data['zorgURL'],
                      dbDir, os.path.join(baseDir, tempDir), secretKey,
                      dict([(k,DBInfo.fromData(dbDirPath, v,
                                               default_email_config))
                                     for k,v in data['databases'].items()]),
                      data.get('baselineRevision', '144168'))

    def __init__(self, name, zorgURL, dbDir, tempDir, secretKey, databases,
                 baselineRevision):
        self.name = name
        self.zorgURL = zorgURL
        self.dbDir = dbDir
        self.tempDir = tempDir
        self.secretKey = secretKey
        while self.zorgURL.endswith('/'):
            self.zorgURL = zorgURL[:-1]
        self.databases = databases
        for db in self.databases.values():
            db.config = self
        self.baselineRevision = baselineRevision

    def get_database(self, name, echo=False):
        """
        get_database(name, echo=False) -> db or None

        Return the appropriate instance of the database with the given name, or
        None if there is no database with that name."""

        # Get the database entry.
        db_entry = self.databases.get(name)
        if db_entry is None:
            return None

        # Instantiate the appropriate database version.
        if db_entry.db_version == '0.4':
            return lnt.server.db.v4db.V4DB(db_entry.path, self, echo=echo)

        raise NotImplementedError,"unable to load version %r database" % (
            db_entry.db_version,)

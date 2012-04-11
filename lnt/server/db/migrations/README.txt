This directory contains "upgrade scripts" for updating databases from one
version to another.

It is important that the scripts be "stable", in that they always function the
same even as the LNT software itself changes. For this reason, the scripts
generally define their own model definitions to match the schema of the LNT
database at the time of the version they are upgrading from (or to).

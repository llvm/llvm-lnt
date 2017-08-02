# Rename 'name' field in machine parameters to 'hostname' to avoid name clash
# in import/export file format.
import sqlalchemy
import json


def update_testsuite(engine, db_key_name):
    class Machine(object):
        pass

    session = sqlalchemy.orm.sessionmaker(engine)()
    meta = sqlalchemy.MetaData(bind=engine)

    machine_table = sqlalchemy.Table("%s_Machine" % db_key_name, meta,
                                     autoload=True)
    sqlalchemy.orm.mapper(Machine, machine_table)

    all_machines = session.query(Machine)
    for machine in all_machines:
        info = dict(json.loads(machine.Parameters))
        name = info.pop('name', None)
        if name is not None:
            info['hostname'] = name
        machine.Parameters = json.dumps(sorted(info.items()))

    session.commit()
    session.close()


def upgrade(engine):
    update_testsuite(engine, 'NT')
    update_testsuite(engine, 'Compile')

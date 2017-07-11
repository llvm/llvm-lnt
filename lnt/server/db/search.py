import re


def _naive_search_for_run(ts, query, num_results, default_machine):
    """
    This 'naive' search doesn't rely on any indexes so can be used without
    full-text search enabled. This does make it less clever however.

    It is able to match queries for machine names and order numbers
    (specifically llvm_project_revision numbers). The revision numbers may be
    partial and may be preceded by '#' or 'r'. Any other non-integer tokens are
    considered to be partial matches for a machine name; any machine that
    contains ALL of the tokens will be searched.
    """

    order_re = re.compile(r'[r#]?(\d+)')
    machine_queries = []
    order_queries = []

    # First, tokenize the query string.
    for q in query.split(' '):
        if not q:
            # Prune zero-length tokens
            continue
        m = order_re.match(q)
        if m:
            order_queries.append(int(m.group(1)))
        else:
            machine_queries.append(q)

    if not machine_queries and not default_machine:
        # No machines to query: no matches. We can't query all machines, we'd
        # end up doing a full table scan and that is not scalable.
        return []

    machines = []
    if not machine_queries:
        machines = [default_machine]
    else:
        for m in ts.query(ts.Machine).all():
            if all(q in m.name for q in machine_queries):
                machines.append(m.id)

    if not machines:
        return []

    llvm_project_revision_idx = [i
                                 for i, f in enumerate(ts.Order.fields)
                                 if f.name == 'llvm_project_revision'][0]
    llvm_project_revision_col = \
        ts.Order.fields[llvm_project_revision_idx].column

    q = ts.query(ts.Run) \
          .filter(ts.Run.machine_id.in_(machines)) \
          .filter(ts.Run.order_id == ts.Order.id) \
          .filter(llvm_project_revision_col.isnot(None))
    if order_queries:
        oq = '%' + str(order_queries[0]) + '%'
        q = q.filter(llvm_project_revision_col.like(oq))

    return q.order_by(ts.Run.id.desc()).limit(num_results).all()


def search(ts, query,
           num_results=8, default_machine=None):
    """
    Performs a textual search for a run. The exact syntax supported depends on
    the engine used to perform the search; see _naive_search_for_run for the
    minimum supported syntax.

    ts: TestSuite object
    query: Textual query string
    num_results: Number of results to return
    default_machine: If no machines were specified (only orders), return
    results from this machine.

    Returns a list of Run objects.
    """

    return _naive_search_for_run(ts, query,
                                 num_results, default_machine)

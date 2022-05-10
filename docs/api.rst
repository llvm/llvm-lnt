.. _api:

Accessing Data outside of LNT: REST API
=======================================

LNT provides REST APIs to access data stored in the LNT database.


Endpoints
---------

The API endpoints live under the top level api path, and have the same database and test-suite layout. For example::

    http://lnt.llvm.org/db_default/v4/nts/machine/1330
    Maps to:
    http://lnt.llvm.org/api/db_default/v4/nts/machines/1330

The machines endpoint allows access to all the machines, and properties and runs collected for them. The runs endpoint
will fetch run and sample data. The samples endpoint allows for the bulk export of samples from a number of runs at
once.

+---------------------------------+------------------------------------------------------------------------------------+
| Endpoint                        | Description                                                                        |
+---------------------------------+------------------------------------------------------------------------------------+
| /machines/                      | List all the machines in this testsuite.                                           |
+---------------------------------+------------------------------------------------------------------------------------+
| /machines/`id`                  | Get all the runs info and machine fields for machine `id`.                         |
+---------------------------------+------------------------------------------------------------------------------------+
| /runs/`id`                      | Get all the run info and sample data for one run `id`.                             |
+---------------------------------+------------------------------------------------------------------------------------+
| /orders/`id`                    | Get all order info for Order `id`.                                                 |
+---------------------------------+------------------------------------------------------------------------------------+
| /samples?runid=1&runid=2        | Retrieve all the sample data for a list of run ids.  Run IDs should be pass as args|
|                                 | Will return sample data in the samples section, as a list of dicts, with a key for |
|                                 | each metric type. Empty samples are not sent.                                      |
+---------------------------------+------------------------------------------------------------------------------------+
| /samples/`id`                   | Get all non-empty sample info for Sample `id`.                                     |
+---------------------------------+------------------------------------------------------------------------------------+
| /schema                         | Return test suite schema.                                                          |
+---------------------------------+------------------------------------------------------------------------------------+
| /fields                         | Return all fields in this testsuite.                                               |
+---------------------------------+------------------------------------------------------------------------------------+
| /tests                          | Return all tests in this testsuite.                                                |
+---------------------------------+------------------------------------------------------------------------------------+
| /graph_for_sample/`id`/`f_name` | Redirect to a graph which contains the sample with ID `id` and the field           |
|                                 | `f_name`.  This can be used to generate a link to a graph based on the sample data |
|                                 | that is returned by the run API. Any parameters passed to this endpoint are        |
|                                 | appended to the graph URL to control formatting etc of the graph. Note, this       |
|                                 | endpoint is not under /api/, but matches the graph URL location.                   |
+---------------------------------+------------------------------------------------------------------------------------+

.. _auth_tokens:

Write Operations
----------------

The machines, orders and runs endpoints also support the DELETE http method.  The user must include a http header called
"AuthToken" which has the API auth token set in the LNT instance configuration.

The API Auth token can be set by adding `api_auth_token` to the instances lnt.cfg config file::

    # API Auth Token
    api_auth_token = "SomeSecret"

Example::

    curl --request DELETE --header "AuthToken: SomeSecret" http://localhost:8000/api/db_default/v4/nts/runs/1

Accessing Data outside of LNT: Tableau Web Data Connector
=========================================================

`Tableau Analytics <https://www.tableau.com>`_ is a popular data analytics platform.  LNT has a builtin Tableau Web Data
Connector (WDC) to make it easy to get LNT data into Tableau.

In Tableau, create a new data source of the Web Data Connector type.  When prompted for the URL, use the standard
database and suite url, followed by /tableau.

Examples::

    # WDC for a public server
    https://lnt.llvm.org/db_default/v4/nts/tableau

    # WDC for a local instance
    http://localhost:5000/db_default/v4/nts/tableau

    # WDC for a different database and suite
    http://localhost:5000/db_my_perf/v4/size/tableau

The WDC exports all the data submitted for a collection of machines. The WDC will prompt for a machine regular
expression. The regexp matches against the machine names in this database/suite. You can see those machine names at a
url like `<base>/db_default/v4/nts/machine/`.

The regular expression is a `JavaScript regular expression <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions/Cheatsheet>`_.

The regexes will depend on your machine names. Some hypothetical examples with a machine name format of clang-arch-branch::

    .* # All machines.
    clang-.* # All clang machines.
    clang-arm(64|32)-branch # Arm64 and Arm32
    clang-arm64-.* # All the branches.

The WDC will then populate all the data for the selected machines.

Note: to improve performance the WDC has incremental support. Once results are downloaded, they should refresh and get
new results quickly.

You can have more than one WDC connection to a LNT server.

.. _api:

Accessing Data outside of LNT: REST API
=======================================

LNT provides comprehensive REST APIs to access and manage data stored in the LNT database.

Quick Reference
---------------

Complete Endpoint Summary
~~~~~~~~~~~~~~~~~~~~~~~~~

+-------+-------------------------------------------------------+---------------------------+
| Method| Endpoint                                              | Authentication Required   |
+=======+=======================================================+===========================+
| GET   | /fields                                               | No                        |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /tests                                                | No                        |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /schema                                               | No                        |
+-------+-------------------------------------------------------+---------------------------+
| POST  | /schema                                               | **Yes**                   |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /machines                                             | No                        |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /machines/<machine_spec>                              | No                        |
+-------+-------------------------------------------------------+---------------------------+
| PUT   | /machines/<machine_spec>                              | **Yes**                   |
+-------+-------------------------------------------------------+---------------------------+
| POST  | /machines/<machine_spec>                              | **Yes**                   |
+-------+-------------------------------------------------------+---------------------------+
| DELETE| /machines/<machine_spec>                              | **Yes**                   |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /runs/<run_id>                                        | No                        |
+-------+-------------------------------------------------------+---------------------------+
| POST  | /runs                                                 | **Yes**                   |
+-------+-------------------------------------------------------+---------------------------+
| DELETE| /runs/<run_id>                                        | **Yes**                   |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /samples                                              | No                        |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /samples/<sample_id>                                  | No                        |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /orders/<order_id>                                    | No                        |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /graph/<machine_id>/<test_id>/<field_index>           | No                        |
+-------+-------------------------------------------------------+---------------------------+
| GET   | /regression/<machine_id>/<test_id>/<field_index>      | No                        |
+-------+-------------------------------------------------------+---------------------------+

All endpoints are prefixed with: ``/api/db_<database>/v4/<testsuite>``

Overview
--------

The REST API provides programmatic access to:

* **Test suites** - Schema definitions and test metadata
* **Machines** - Test execution machines and their configurations
* **Runs** - Test execution results and submission
* **Samples** - Individual test measurements and metrics
* **Orders** - Ordering information for test runs
* **Regressions** - Performance regression data
* **Graphs** - Historical performance data for visualization

All API endpoints follow the pattern::

    http://<server>/api/db_<database>/v4/<testsuite>/<resource>

For example::

    http://lnt.llvm.org/api/db_default/v4/nts/machines/1330

Response Format
---------------

All API responses are JSON formatted and include common metadata fields:

* ``generated_by`` - LNT server version that generated the response

Example response structure::

    {
        "generated_by": "LNT Server <version>",
        "machines": [...],
        "runs": [...]
    }

All responses include CORS headers (``Access-Control-Allow-Origin: *``) to support cross-origin requests.

.. _auth_tokens:

Authentication
--------------

**Read Operations**: All GET requests are unauthenticated and publicly accessible.

**Write Operations**: POST, PUT, and DELETE requests require authentication via an ``AuthToken`` HTTP header.

To enable authentication, add the ``api_auth_token`` setting to your instance's ``lnt.cfg`` configuration file::

    # API Auth Token
    api_auth_token = "SomeSecret"

Include this token in the request header::

    curl --request DELETE \
         --header "AuthToken: SomeSecret" \
         http://localhost:8000/api/db_default/v4/nts/runs/1

Without a valid token, write operations will return HTTP 401 Unauthorized.

Error Handling
--------------

HTTP Status Codes
~~~~~~~~~~~~~~~~~

The API uses standard HTTP status codes:

* **200 OK** - Successful GET request
* **201 Created** - Successful POST request (e.g. schema creation)
* **301 Moved Permanently** - Successful run submission with redirect to the created resource
* **400 Bad Request** - Invalid request data or parameters
* **401 Unauthorized** - Missing or invalid authentication token
* **404 Not Found** - Requested resource does not exist
* **415 Unsupported Media Type** - Invalid Content-Type header

Error Response Format
~~~~~~~~~~~~~~~~~~~~~

Error responses include a descriptive message:

.. code-block:: json

    {
        "msg": "Auth Token must be passed in AuthToken header, and included in LNT config.",
        "status": 401
    }

API Endpoints
-------------

Test Suite Metadata
~~~~~~~~~~~~~~~~~~~

Fields
^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/fields``

Lists all sample fields (metrics) defined in the test suite.

**Response:**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "fields": [
            {
                "column_id": 0,
                "column_name": "compile_time",
                "column_type": "REAL"
            },
            {
                "column_id": 1,
                "column_name": "execution_time",
                "column_type": "REAL"
            }
        ]
    }

Tests
^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/tests``

Lists all tests registered in the test suite.

**Response:**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "tests": [
            {
                "id": 1,
                "name": "test.compile.time"
            },
            {
                "id": 2,
                "name": "test.execution.time"
            }
        ]
    }

Schema
^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/schema``

Returns the complete test suite schema definition.

**Response:** The full schema object in JSON format.

**POST** ``/api/db_<database>/v4/<testsuite>/schema``

Creates or updates a test suite schema. Requires authentication.

**Headers:**

* ``AuthToken: <token>`` (required)
* ``Content-Type: application/x-yaml`` (required)

**Request Body:** YAML schema definition (see schemas/ directory for examples)

**Example:**

.. code-block:: bash

    curl --request POST \
         --header "AuthToken: SomeSecret" \
         --header "Content-Type: application/x-yaml" \
         --data-binary @my_suite.yaml \
         http://localhost:8000/api/db_default/v4/my_suite/schema

**Response (201 Created):**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "testsuite": "my_suite",
        "schema": {}
    }

**Error Responses:**

* 400 Bad Request - Invalid YAML, missing required fields, or schema validation errors
* 401 Unauthorized - Missing or invalid AuthToken
* 415 Unsupported Media Type - Content-Type is not application/x-yaml

Machines
~~~~~~~~

List Machines
^^^^^^^^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/machines``

Lists all machines registered in the test suite.

**Response:**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "machines": [
            {
                "id": 1,
                "name": "machine1",
                "info": {}
            }
        ]
    }

Machine Details
^^^^^^^^^^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/machines/<machine_spec>``

Retrieves detailed information about a specific machine and all runs executed on it.

**Parameters:**

* ``machine_spec`` - Machine ID (numeric) or machine name (string)

**Response:**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "machine": {
            "id": 1,
            "name": "machine1",
            "info": {}
        },
        "runs": [
            {
                "id": 101,
                "machine_id": 1,
                "order": {},
                "start_time": "2026-01-15T10:30:00"
            }
        ]
    }

**Error Responses:**

* 404 Not Found - Machine not found or ambiguous name (use ID instead)

Delete Machine
^^^^^^^^^^^^^^

**DELETE** ``/api/db_<database>/v4/<testsuite>/machines/<machine_spec>``

Deletes a machine and all associated runs. Requires authentication.

**Headers:**

* ``AuthToken: <token>`` (required)

**Response:** Streaming text response showing deletion progress

**Example:**

.. code-block:: bash

    curl --request DELETE \
         --header "AuthToken: SomeSecret" \
         http://localhost:8000/api/db_default/v4/nts/machines/1

Update Machine
^^^^^^^^^^^^^^

**PUT** ``/api/db_<database>/v4/<testsuite>/machines/<machine_spec>``

Updates machine information. Requires authentication.

**Headers:**

* ``AuthToken: <token>`` (required)
* ``Content-Type: application/json`` (required)

**Request Body:**

.. code-block:: json

    {
        "machine": {
            "name": "new_name",
            "info": {}
        }
    }

Machine Operations
^^^^^^^^^^^^^^^^^^

**POST** ``/api/db_<database>/v4/<testsuite>/machines/<machine_spec>``

Performs special operations on machines. Requires authentication.

**Headers:**

* ``AuthToken: <token>`` (required)

**Rename Machine:**

.. code-block:: bash

    curl --request POST \
         --header "AuthToken: SomeSecret" \
         --data "action=rename&name=new_machine_name" \
         http://localhost:8000/api/db_default/v4/nts/machines/1

**Merge Machines:**

Merges all runs from one machine into another, then deletes the source machine.

.. code-block:: bash

    curl --request POST \
         --header "AuthToken: SomeSecret" \
         --data "action=merge&into=2" \
         http://localhost:8000/api/db_default/v4/nts/machines/1

**Error Responses:**

* 400 Bad Request - Missing action parameter, invalid action, or operation-specific errors
* 401 Unauthorized - Missing or invalid AuthToken

Runs
~~~~

Get Run
^^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/runs/<run_id>``

Retrieves complete information about a specific run, including all sample data.

**Response:**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "run": {
            "id": 101,
            "machine_id": 1,
            "order_id": 50,
            "start_time": "2026-01-15T10:30:00",
            "end_time": "2026-01-15T11:30:00"
        },
        "machine": {
            "id": 1,
            "name": "machine1"
        },
        "tests": [
            {
                "id": 1001,
                "run_id": 101,
                "name": "test.compile.time",
                "compile_time": 1.23,
                "execution_time": 0.45
            }
        ]
    }

**Error Responses:**

* 404 Not Found - Run not found

Delete Run
^^^^^^^^^^

**DELETE** ``/api/db_<database>/v4/<testsuite>/runs/<run_id>``

Deletes a specific run and all associated sample data. Requires authentication.

**Headers:**

* ``AuthToken: <token>`` (required)

**Example:**

.. code-block:: bash

    curl --request DELETE \
         --header "AuthToken: SomeSecret" \
         http://localhost:8000/api/db_default/v4/nts/runs/101

Submit Run
^^^^^^^^^^

**POST** ``/api/db_<database>/v4/<testsuite>/runs``

Submits new test run data to the database. Requires authentication.

**Headers:**

* ``AuthToken: <token>`` (required)
* ``Content-Type: application/json`` (required)

**Query Parameters:**

* ``select_machine`` - Machine selection strategy (default: "match")
* ``merge`` - Run ID to merge with (optional)
* ``ignore_regressions`` - Skip regression detection (optional, boolean)

**Request Body:** JSON or Property List formatted run data (see :ref:`importing_data` for format)

**Response (301 Moved Permanently):**

.. code-block:: json

    {
        "success": true,
        "run_id": 102,
        "result_url": "http://localhost:8000/api/db_default/v4/nts/runs/102"
    }

**Error Responses:**

* 400 Bad Request - Invalid data format or submission rejected
* 401 Unauthorized - Missing or invalid AuthToken

Samples
~~~~~~~

Get Sample
^^^^^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/samples/<sample_id>``

Retrieves a specific sample's data.

**Response:**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "samples": [
            {
                "id": 1001,
                "run_id": 101,
                "test_id": 1,
                "compile_time": 1.23,
                "execution_time": 0.45
            }
        ]
    }

Query Samples
^^^^^^^^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/samples?runid=<id>&runid=<id>...``

Retrieves sample data for multiple runs. Useful for bulk data export.

**Query Parameters:**

* ``runid`` - Run ID (can be specified multiple times)

**Example:**

.. code-block:: bash

    curl "http://localhost:8000/api/db_default/v4/nts/samples?runid=101&runid=102&runid=103"

**Response:**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "samples": [
            {
                "id": 1001,
                "run_id": 101,
                "name": "test.compile.time",
                "llvm_project_revision": "abc123",
                "compile_time": 1.23
            },
            {
                "id": 1002,
                "run_id": 102,
                "name": "test.compile.time",
                "llvm_project_revision": "def456",
                "compile_time": 1.25
            }
        ]
    }

Empty samples (all fields are null) are omitted from results.

**Error Responses:**

* 400 Bad Request - No runid parameters provided

Orders
~~~~~~

Get Order
^^^^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/orders/<order_id>``

Retrieves order information (version/revision tracking).

**Response:**

.. code-block:: json

    {
        "generated_by": "LNT Server <version>",
        "orders": [
            {
                "id": 50,
                "llvm_project_revision": "abc123",
                "previous_order_id": 49
            }
        ]
    }

Graphs and Regressions
~~~~~~~~~~~~~~~~~~~~~~~

Graph Data
^^^^^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/graph/<machine_id>/<test_id>/<field_index>``

Retrieves time-series data for graphing a specific metric on a machine/test combination.

**Query Parameters:**

* ``limit`` - Maximum number of data points to return (optional)

**Response:**

.. code-block:: json

    [
        [
            "abc123",
            1.23,
            {
                "label": "abc123",
                "date": "2026-01-15 10:30:00",
                "runID": "101"
            }
        ],
        [
            "def456",
            1.25,
            {
                "label": "def456",
                "date": "2026-01-16 10:30:00",
                "runID": "102"
            }
        ]
    ]

Each data point is an array: ``[revision, value, metadata]``

Regression Data
^^^^^^^^^^^^^^^

**GET** ``/api/db_<database>/v4/<testsuite>/regression/<machine_id>/<test_id>/<field_index>``

Retrieves regression information for a specific metric on a machine/test combination.

**Response:**

.. code-block:: json

    [
        {
            "id": 1,
            "title": "Performance regression in test.compile.time",
            "state": "active",
            "end_point": ["def456", 1.35]
        }
    ]

**Error Responses:**

* 404 Not Found - Invalid machine, test, or field

Usage Examples
--------------

**List all machines:**

.. code-block:: bash

    curl http://localhost:8000/api/db_default/v4/nts/machines

**Get run details:**

.. code-block:: bash

    curl http://localhost:8000/api/db_default/v4/nts/runs/101

**Delete a run:**

.. code-block:: bash

    curl --request DELETE \
         --header "AuthToken: SomeSecret" \
         http://localhost:8000/api/db_default/v4/nts/runs/101

**Bulk sample export:**

.. code-block:: bash

    curl "http://localhost:8000/api/db_default/v4/nts/samples?runid=101&runid=102&runid=103" \
         | python -m json.tool

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

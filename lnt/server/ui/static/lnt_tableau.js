/*jslint browser: true, devel: true*/
/*global $, jQuery, tableau, ts_url */

(function() {
  // Create the connector object.
  var myConnector = tableau.makeConnector();

  // TODO: make the server report types.
  // Map LNT types to Tableau datatypes.
  var col_type_mapper = {
    "compile_status": tableau.dataTypeEnum.int,
    "execution_status": tableau.dataTypeEnum.int,
    "compile_time": tableau.dataTypeEnum.float,
    "execution_time": tableau.dataTypeEnum.float,
    "score": tableau.dataTypeEnum.int,
    "mem_bytes": tableau.dataTypeEnum.int,
    "hash_status": tableau.dataTypeEnum.int,
    "hash": tableau.dataTypeEnum.string,
    "code_size": tableau.dataTypeEnum.int};

  /** Get a json payload from the LNT server asynchronously or error.
   * @param {string} payload_url JSON payloads URL.
   */
  function getValue(payload_url) {
    var response = $.ajax({
      url: payload_url,
      async: false,
      cache: false,
      timeout: 60000, // Make all requests timeout after a minute.
    });

    if (response.status >= 400) {
      var error_msg = "Requesting data from LNT failed with:\n\n HTTP " +
        response.status + ": " + response.responseText + "\n\nURL: " +
        payload_url
      tableau.abortWithError(error_msg);
      throw new Error(error_msg);
    }

    return JSON.parse(response.responseText);
  }

  function get_matching_machines(regexp) {
    const name_regexp = new RegExp(regexp);
    var resp = getValue(ts_url + "/machines/");
    var machines = resp.machines;
    return machines.filter(function (name_ids) {
      return name_regexp.test(name_ids.name);
    });
  }

  // Define the schema.
  myConnector.getSchema = function (schemaCallback) {
    var search_info = JSON.parse(tableau.connectionData);
    tableau.reportProgress("Getting Schema from LNT.");

    // Lookup machines of interest, and gather run fields.
    var machine_names = get_matching_machines(search_info.machine_regexp);
    if (machine_names.length === 0) {
      tableau.abortWithError("Did not match any machine names matching: " +
          search_info.machine_regexp);
    }

    var field_info = getValue(ts_url + "/fields/");

    var fields = field_info.fields;
    var cols = [];
    cols.push({
        id: "machine_name",
        alias: "Machine Name",
        dataType: tableau.dataTypeEnum.string
      });
      cols.push({
        id: "run_id",
        alias: "Run ID",
        dataType: tableau.dataTypeEnum.int
      });
      cols.push({
        id: "run_order",
        alias: "Run Order",
        dataType: tableau.dataTypeEnum.string
      });
      cols.push({
        id: "run_date",
        alias: "Run DateTime",
        dataType: tableau.dataTypeEnum.datetime
      });
      cols.push({
        id: "test_name",
        alias: "Test",
        dataType: tableau.dataTypeEnum.string
      });

      fields.forEach(function(field) {
        cols.push({
          id: field.column_name,
          alias: field.column_name,
          dataType: col_type_mapper[field.column_name]
        });
      });
      var tableSchema = {
        id: "lnt_machine_feed",
        alias: "Performance Data from " + field_info.generated_by,
        columns: cols,
        incrementColumnId: "run_id"
    };
    schemaCallback([tableSchema]);
  }


  // Download the data.
  myConnector.getData = function (table, doneCallback) {
    var last_run_id = parseInt(table.incrementValue || 0);

    // Get latest machines.
    var search_info = JSON.parse(tableau.connectionData);
    var machine_names = get_matching_machines(search_info.machine_regexp);
    if (machine_names.length === 0) {
      tableau.abortWithError("Did not match any machine names matching: " +
          search_info.machine_regexp);
    } else {
       tableau.reportProgress("Found " + machine_names.length +
           " machines to fetch.");
    }

    machine_names.forEach(function (machine) {
      var url = ts_url + "/machines/" + machine.id;
      var machine_info = getValue(url);
      var machine_name = machine_info.machine.name;
      var tableData = [];

      machine_info.runs.forEach(function(run, index) {
        var run_data;
        var runs_total = machine_info.runs.length;
        // Run based incremental refresh. If we have already seen data, skip it.
        if (run.id <= last_run_id) {
          return;
        }

        var status_msg = "Getting Machine: " + machine_name
           + " Run: " + run.id
           + " (" + (index + 1) + "/" + runs_total + ")";

        tableau.reportProgress(status_msg);
        run_data = getValue(ts_url + "/runs/" + run.id);

        var date_str = run_data.run.end_time;
        var run_date = new Date(date_str);
        var derived_run_data = {
          "machine_name": machine_name,
          "run_id": run.id,
          "run_order": run[run.order_by],
          "run_date": run_date
        };
        run_data.tests.forEach(function (element) {
          element.test_name = element.name;
          delete element.name;
          var data = Object.assign({}, derived_run_data, element);
          tableData.push(data);

        });
        run_data = null;
      });

      table.appendRows(tableData);

    });
    doneCallback();
  };

  tableau.registerConnector(myConnector);

  // Create event listeners for when the user submits the form.
  $(document)
    .ready(function () {
      $("#submitButton")
        .click(function () {
          var requested_machines = {
            machine_regexp: $("#machine-name")
              .val()
              .trim()
          };
          // This will be the data source name in Tableau.
          tableau.connectionName = requested_machines.machine_regexp + " (LNT)";
          tableau.connectionData = JSON.stringify(requested_machines);
          tableau.submit(); // This sends the connector object to Tableau
        });
    });
})();



/*jslint vars: true, browser: true,  devel: true, plusplus: true, unparam: true*/
/*global $, jQuery, alert, db_name, test_suite_name */

var STATE_NAMES = {0: 'Detected',
                   1: 'Staged',
                   10: 'Active',
                   20: 'Not to be Fixed',
                   21: 'Ignored',
                   23: 'Verify',
                   22: 'Fixed'};

var regression_cache = [];
var lnt_graph = {};

// Grab the graph API url for this line.
function get_api_url(kind, db, ts, mtf) {
    "use strict";
    return [lnt_url_base, "api", "db_" + db, "v4", ts, kind, mtf].join('/');
}

// Grab the URL for a machine by id.
function get_machine_url(db, ts, machineID) {
    "use strict";
    return [lnt_url_base, "db_" + db, "v4", ts, "machine", machineID].join('/');
}

// Grab the URL for a order by id.
function get_order_url(db, ts, orderID) {
    "use strict";
    return [lnt_url_base, "db_" + db, "v4", ts, "order", orderID].join('/');
}

// Grab the URL for a run by id.
function get_run_url(db, ts, runID) {
    "use strict";
    return [lnt_url_base, "db_" + db, "v4", ts, runID].join('/');
}

// Grab the URL for a regression by id.
function get_regression_url(db, ts, regression) {
    "use strict";
    return [lnt_url_base, "db_" + db, "v4", ts, "regressions", regression].join('/');
}

// Create a new regression manually URL.
function get_manual_regression_url(db, ts, url, runID) {
    "use strict";
    return [lnt_url_base, "db_" + db, "v4", ts, "regressions/new_from_graph", url, runID].join('/');
}

// Show our overlay tooltip.
lnt_graph.current_tip_point = null;

function plotly_show_tooltip(data) {
    "use strict";
    var tip_body = '<div id="tooltip">';
    var point = data.points[0];

    if (point.data.regression && point.data.regressionID) {
        tip_body +=  "<b><a href=\"" +
            get_regression_url(db_name, test_suite_name, point.data.regressionID) +
            "\">" + point.data.regression + "</a></b></br>";
    }

    if (point.data.machine && point.data.machineID) {
        tip_body += "<b>Machine:</b> <a href=\"" +
            get_machine_url(db_name, test_suite_name, point.data.machineID) +
            "\">" + point.data.machine + "</a><br>";
    }

    if (point.data.test_name) {
        tip_body += "<b>Test:</b> " + point.data.test_name + "<br>";
    }

    if (point.data.metric) {
        tip_body += "<b>Metric:</b> " + point.data.metric + "<br>";
    }

    if (point.meta.order) {
      if (point.meta.orderID) {
        tip_body += "<b>Order:</b> <a href=\"" +
            get_order_url(db_name, test_suite_name, point.meta.orderID) +
            "\">" + point.meta.order + "</a><br>";
      } else {
        tip_body += "<b>Order:</b> " + point.meta.order + "<br>";
      }
    }

    tip_body += "<b>Value:</b> " + point.y.toFixed(4) + "<br>";

    if (point.meta.date) {
        tip_body += "<b>Date:</b> " + point.meta.date + "<br>";
    }

    if (point.meta.state) {
        tip_body += "<b>State:</b> " + point.meta.state + "<br>";
    }

    if (point.meta.runID) {
        tip_body += "<b>Run:</b> <a href=\"" +
            get_run_url(db_name, test_suite_name, point.meta.runID) +
            "\">" + point.meta.runID + "</a><br>";
    }
    
    if (point.meta.runID && point.data.url) { // url = machine.id/test.id/field_index
        tip_body += "<a href=\"" +
            get_manual_regression_url(db_name, test_suite_name, point.data.url, point.meta.runID) +
            "\">Mark Change.</a><br>";
    }

    tip_body += "</div>";
    var tooltip_div = $(tip_body).css({
        position: 'absolute',
        display: 'none',
        top: data.event.pageY + 5,
        left: data.event.pageX + 5,
        border: '1px solid #fdd',
        padding: '2px',
        'background-color': '#fee',
        opacity: 0.80,
        'z-index': 100000
    }).appendTo("body").fadeIn(200);

    // Now make sure the tool tip is on the graph canvas.
    var tt_position = tooltip_div.position();

    var graph_div = $("#graph");
    var graph_position = graph_div.position();

    // The right edge of the graph.
    var max_width = graph_position.left + graph_div.width();
    // The right edge of the tool tip.
    var tt_right = tt_position.left + tooltip_div.width();

    if (tt_right > max_width) {
        var diff = tt_right - max_width;
        var GRAPH_BORDER = 10;
        var VISUAL_APPEAL = 10;
        tooltip_div.css({'left' : tt_position.left - diff
                         - GRAPH_BORDER - VISUAL_APPEAL});
    }

}

// Event handler function to update the tooltop.
function plotly_update_tooltip(data) {
    "use strict";
    if (!data || data.points.length == 0) {
        $("#tooltip").fadeOut(200, function () {
            $("#tooltip").remove();
        });
        lnt_graph.current_tip_point = null;
        return;
    }

    if (!lnt_graph.current_tip_point || (lnt_graph.current_tip_point[0] !== data.points.curveNumber ||
                                         lnt_graph.current_tip_point[1] !== data.points.pointNumber)) {
        $("#tooltip").remove();
        lnt_graph.current_tip_point = [data.points[0].curveNumber, data.points[0].pointNumber];
        plotly_show_tooltip(data);
    }
}

function plotly_hide_tooltip(data) {
    "use strict";
    plotly_update_tooltip(null);
}

function get_regression_id() {
    "use strict";
    var path = window.location.pathname.split("/");
    if (path[path.length - 2] === "regressions") {
        return parseInt(path[path.length - 1], 10);
    }
}

function plotly_graph_regression_callback(data, index, item, yaxis, update_func) {
    "use strict";
    $.each(data, function (i, r) {
        if (get_regression_id() !== null) {
            if (get_regression_id() === r.id || r.state === 21) {
                return;
            }
        }
        if (!(regression_cache[index])) {
            regression_cache[index] = [];
        }
        regression_cache[index].push({
            "x": [r.end_point[0]],
            "y": [r.end_point[1]],
            "meta": [{
              "order": r.end_point[0],
              "state": STATE_NAMES[r.state]
            }],
            "name": r.title,
            "machine": item[0].name,
            "machineID": item[0].id,
            "metric": item[2],
            "yaxis": yaxis,
            "regression": r.title,
            "regressionID": r.id,
            "legendgroup": "regressions",
            "showlegend": true,
            "mode": "markers",
            "marker": {
                "color": "red",
                "symbol": "triangle-up-open",
                "size": 13}
        });
    });
    update_func();
}

/* On the normal graph page, data is loaded during page load.
This function takes the plots from page load and adds the regressions
that are asynchrounusly fetched.
*/
function plotly_update_graphplots(old_plot) {
    "use strict";
    // Regressions.
    var new_plot = $.extend([], old_plot);
    for (var i = 0; i < regression_cache.length; i++) {
        if (regression_cache[i]) {
            regression_cache[i].forEach(function(j){
                new_plot.push(j);
            });
        }
    }
    return new_plot;
}

/*jslint vars: true, browser: true,  devel: true, plusplus: true, unparam: true*/
/*global $, jQuery, alert, db_name, test_suite_name, init, changes */
/*global update_graph*/
// Keep the graph data we download.
// Each element is a list of graph data points.
var data_cache = [];
var is_checked = []; // The current list of lines to plot.
var normalize = false;
var prefix = "";

var MAX_TO_DRAW = 10;

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
    return [prefix, "api", "db_" + db, "v4", ts, kind, mtf].join('/');
}

// Grab the URL for a regression by id.
function get_regression_url(db, ts, regression) {
    "use strict";
    return [prefix, "db_" + db, "v4", ts, "regressions", regression].join('/');
}

// Grab the URL for a run by id.
function get_run_url(db, ts, runID) {
    "use strict";
    return [prefix, "db_" + db, "v4", ts, runID].join('/');
}

// Create a new regression manually URL.
function get_manual_regression_url(db, ts, url, runID) {
    "use strict";
    return [prefix,
        "db_" + db,
        "v4",
        ts,
        "regressions/new_from_graph",
        url,
        runID].join('/');
}



/* Bind events to the zoom bar buttons, so that 
 * the zoom buttons work, then position them
 * over top of the main graph.
 */
function bind_zoom_bar(my_plot) {
    "use strict";
    $('#out').click(function (e) {
        e.preventDefault();
        my_plot.zoomOut();
    });

    $('#in').click(function (e) {
        e.preventDefault();
        my_plot.zoom();
    });

    // Now move the bottons onto the graph.
    $('#graphbox').css('position', 'relative');
    $('#zoombar').css('position', 'absolute');

    $('#zoombar').css('left', '40px');
    $('#zoombar').css('top', '15px');

}


// Show our overlay tooltip.
lnt_graph.current_tip_point = null;

function show_tooltip(x, y, item, pos, graph_data) {
    "use strict";
    // Given the event handler item, get the graph metadata.
    function extract_metadata(item) {
        var index = item.dataIndex;
        // Graph data is formatted as [x, y, meta_data].
        var meta_data = item.series.data[index][2];
        return meta_data;
    }
    var data = item.datapoint;
    var meta_data = extract_metadata(item);
    var tip_body = '<div id="tooltip">';

    if (meta_data.title) {
        tip_body +=  "<b><a href=\"" + meta_data.link + "\">" + meta_data.title + "</a></b></br>";
    }

    if (meta_data.test_name) {
        tip_body += "<b>Test:</b> " + meta_data.test_name + "<br>";
    }

    if (meta_data.label) {
        tip_body += "<b>Revision:</b> " + meta_data.label + "<br>";
    }
    tip_body += "<b>Value:</b> " + data[1].toFixed(4) + "<br>";

    if (meta_data.date) {
        tip_body += "<b>Date:</b> " + meta_data.date + "<br>";
    }
    if (meta_data.state) {
        tip_body += "<b>State:</b> " + meta_data.state + "<br>";
    }
    if (meta_data.runID) {
        tip_body += "<b>Run:</b> <a href=\"" +
            get_run_url(db_name, test_suite_name, meta_data.runID) +
            "\">" + meta_data.runID + "<br>";
    }
    
    if (meta_data.runID &&  item.series.url) {
        tip_body += "<a href=\"" +
            get_manual_regression_url(db_name, test_suite_name, item.series.url, meta_data.runID) +
            "\">Mark Change.<br>";
    }

    tip_body += "</div>";
    var tooltip_div = $(tip_body).css({
        position: 'absolute',
        display: 'none',
        top: y + 5,
        left: x + 5,
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
function update_tooltip(event, pos, item, show_fn, graph_data) {
    "use strict";
    if (!item) {
        $("#tooltip").fadeOut(200, function () {
            $("#tooltip").remove();
        });
        lnt_graph.current_tip_point = null;
        return;
    }

    if (!lnt_graph.current_tip_point || (lnt_graph.current_tip_point[0] !== item.datapoint[0] ||
                                 lnt_graph.current_tip_point[1] !== item.datapoint[1])) {
        $("#tooltip").remove();
        lnt_graph.current_tip_point = item.datapoint;
        show_fn(pos.pageX, pos.pageY, item, pos, graph_data);
    }
}


// Normalize this data to the element in index
function normalize_data(data_array, index) {
    "use strict";
    var new_data = new Array(data_array.length);
    var i = 0;
    var factor = 0;
    for (i = 0; i < data_array.length; i++) {
        if (data_array[i][0] == index) {
            factor = data_array[i][1];
            break;
        }
    }
    console.assert(factor !== 0, "Did not find the element to normalize on.");
    for (i = 0; i < data_array.length; i++) {
        new_data[i] = jQuery.extend({}, data_array[i]);
        new_data[i][1] = (data_array[i][1] / factor) * 100;
    }
    return new_data;
}


function try_normal(data_array, index) {
    "use strict";
    if (normalize) {
        return normalize_data(data_array, index);
    }
    return data_array;
}


function make_graph_point_entry(data, color, regression) {
    "use strict";
    var radius = 0.25;
    var fill = true;
    if (regression) {
        radius = 5.0;
        fill = false;
        color = "red";
    }
    var entry = {"color": color,
                 "data": data,
                 "lines": {"show": false},
                 "points": {"fill": fill,
                            "radius": radius,
                            "show": true
                           }
                };
    if (regression) {
        entry.points.symbol = "triangle";
    }
    return entry;
}

var color_codes = ["#4D4D4D",
                   "#5DA5DA",
                   "#FAA43A",
                   "#60BD68",
                   "#F17CB0",
                   "#B2912F",
                   "#B276B2",
                   "#DECF3F",
                   "#F15854",
                   "#1F78B4",
                   "#33A02C",
                   "#E31A1C",
                   "#FF7F00",
                   "#6A3D9A",
                   "#A6CEE3",
                   "#B2DF8A",
                   "#FB9A99",
                   "#FDBF6F",
                   "#CAB2D6"];

function new_graph_data_callback(data, index) {
    "use strict";
    data_cache[index] = data;
    update_graph();
}


function get_regression_id() {
    "use strict";
    var path = window.location.pathname.split("/");
    if (path[path.length - 2] === "regressions") {
        return parseInt(path[path.length - 1], 10);
    }
}


function new_graph_regression_callback(data, index, update_func) {
    "use strict";
    $.each(data, function (i, d) {

        if (get_regression_id() !== null) {
            if (get_regression_id() === d.id || d.state === 21) {
                return;
            }
        }
        if (!(regression_cache[index])) {
            regression_cache[index] = [];
        }
        var metadata = {'label': d.end_point[0],
                    'title': d.title,
                    'id': d.id,
                    'link': get_regression_url(db_name, test_suite_name, d.id),
                    'state': STATE_NAMES[d.state]};
        regression_cache[index].push([parseInt(d.end_point[0], 10), d.end_point[1], metadata]);
    });
    update_func();
}


var NOT_DRAWING = '<div class="alert alert-success" role="alert">' +
            'Too many lines to plot. Limit is ' + MAX_TO_DRAW + "." +
            '<a href="#" class="close" data-dismiss="alert" aria-label="close">×</a>' +
            '</div>';


function update_graph() {
    "use strict";
    var to_draw = [];
    var starts = [];
    var ends = [];
    var lines_to_draw = 0;
    var i = 0;
    var color = null;
    var data = null;
    var regressions = null;
    // We need to find the x bounds of the data, sine regressions may be
    // outside that range.
    var mins = [];
    var maxs = [];
    // Data processing.
    for (i = 0; i < changes.length; i++) {
        if (is_checked[i] && data_cache[i]) {
            lines_to_draw++;
            starts.push(changes[i].start);
            ends.push(changes[i].end);
            color = color_codes[i % color_codes.length];
            data = try_normal(data_cache[i], changes[i].start);
            // Find local x-axis min and max.
            var local_min = parseFloat(data[0][0]);
            var local_max = parseFloat(data[0][0]);
            for (var j = 0; j < data.length; j++) {
                var datum = data[j];
                var d = parseFloat(datum[0]);
                if (d < local_min) {
                    local_min = d;
                }
                if (d > local_max) {
                    local_max = d;
                }
            }
            mins.push(local_min);
            maxs.push(local_max);

            to_draw.push(make_graph_point_entry(data, color, false));
            to_draw.push({"color": color, "data": data, "url": changes[i].url});
        }
    }
    // Zoom the graph to only the data sets, not the regressions.
    var min_x = Math.min.apply(Math, mins);
    var max_x = Math.max.apply(Math, maxs);
    // Regressions.
    for (i = 0; i < changes.length; i++) {
        if (is_checked[i] && data_cache[i]) {
            if (regression_cache[i]) {
                regressions = try_normal(regression_cache[i]);
                to_draw.push(make_graph_point_entry(regressions, color, true));
            }
        }
    }
    // Limit the number of lines to plot: the graph gets cluttered and slow.
    if (lines_to_draw > MAX_TO_DRAW) {
        $('#errors').empty().prepend(NOT_DRAWING);
        return;
    }
    var lowest_rev = Math.min.apply(Math, starts);
    var highest_rev = Math.max.apply(Math, ends);
    init(to_draw, lowest_rev, highest_rev, min_x, max_x);
}

// To be called by main page. It will fetch data and make graph ready.
function add_data_to_graph(URL, index, max_samples) {
    "use strict";
    $.getJSON(get_api_url("graph", db_name, test_suite_name, URL) + "?limit=" + max_samples, function (data) {
        new_graph_data_callback(data, index);
    });
    $.getJSON(get_api_url("regression", db_name, test_suite_name, URL) + "?limit=" + max_samples, function (data) {
        new_graph_regression_callback(data, index, update_graph);
    });
    is_checked[index] = true;
}


function init_axis(prefix_url) {
    "use strict";
    function onlyUnique(value, index, self) {
        return self.indexOf(value) === index;
    }
    prefix = prefix_url;
    var metrics = $('.metric').map(function () {
        return $(this).text();
    }).get();
    metrics = metrics.filter(onlyUnique);

    var yaxis_name = metrics.join(", ");
    yaxis_name = yaxis_name.replace("_", " ");

    $('#yaxis').text(yaxis_name);

    $('#normalize').click(function (e) {
        normalize = !normalize;
        if (normalize) {
            $('#normalize').toggleClass("btn-default btn-primary");
            $('#normalize').text("x1");
            $('#yaxis').text("Normalized (%)");
        } else {
            $('#normalize').toggleClass("btn-primary btn-default");
            $('#normalize').text("%");
            $('#yaxis').text(yaxis_name);
        }
        update_graph();
    });

    $('#xaxis').css('position', 'absolute');
    $('#xaxis').css('left', '50%');
    $('#xaxis').css('bottom', '-15px');
    $('#xaxis').css('width', '100px');
    $('#xaxis').css('margin-left', '-50px');

    $('#yaxis').css('position', 'absolute');
    $('#yaxis').css('left', '-55px');
    $('#yaxis').css('top', '50%');
    $('#yaxis').css('-webkit-transform', 'rotate(-90deg)');
    $('#yaxis').css('-moz-transform', 'rotate(-90deg)');
}
/* On the normal graph page, data is loaded during page load.
This function takes the plots from page load and adds the regressions
that are asynchrounusly fetched.
*/
function update_graphplots(old_plot) {
    "use strict";
    // Regressions.
    var regressions = null;
    var i = 0;
    var new_plot = $.extend([], old_plot);
    for (i = 0; i < regression_cache.length; i++) {
        if (regression_cache[i]) {
            regressions = regression_cache[i];
            new_plot.push(make_graph_point_entry(regressions, "#000000", true));
        }
    }
    return new_plot;
}


function init(data, start_highlight, end_highlight, x_min, x_max) {
    "use strict";
    // First, set up the primary graph.
    var graph = $("#graph");
    var graph_plots = data;
    var line_width = 1;
    if (data.length > 0 && data[0].data.length < 50) {
        line_width = 2;
    }
    var graph_options = {
        xaxis: {
          min: x_min,
          max: x_max
        },
        series : {
            lines : {lineWidth : line_width},
            shadowSize : 0
        },
        highlight : {
            range: {"end": [end_highlight], "start": [start_highlight]},
            alpha: "0.35",
            stroke: true
        },
        zoom : { interactive : false },
        pan : { interactive : true,
            frameRate: 60 },
        grid : {
            hoverable : true,
            clickable: true
        }
    };

    var main_plot = $.plot("#graph", graph_plots, graph_options);

    // Add tooltips.
    graph.bind("plotclick", function (e, p, i) {
        update_tooltip(e, p, i, show_tooltip, graph_plots);
    });

    bind_zoom_bar(main_plot);
}

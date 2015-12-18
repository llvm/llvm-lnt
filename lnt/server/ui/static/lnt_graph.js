// Keep the graph data we download.
// Each element is a list of graph data points.
var data_cache = [];
var is_checked = []; // The current list of lines to plot.
var normalize = false;
var MAX_TO_DRAW = 25;

var STATE_NAMES = {0: 'Detected',
                   1: 'Staged',
                   10: 'Active',
                   20: 'Not to be Fixed',
                   21: 'Ignored',
                   23: 'Verify',
                   22: 'Fixed'};

var regression_cache = [];

// Grab the graph API url for this line.
function get_api_url(kind, db, ts, mtf) {
    return ["/api", "db_"+ db, "v4", ts, kind, mtf].join('/');
}

// Grab the URL for a regression by id.
function get_regression_url(db, ts, regression) {
    return ["", "db_"+ db, "v4", ts, "regressions", regression].join('/');
}



function try_normal(data_array, end_rev) {
    $("#graph_range").prop("min", 0);
    var max = $("#graph_range").prop("max");
    if (max < data_array.length) {
        $("#graph_range").prop("max", data_array.length);
    }
    var center = -1;
    for (var i = 0; i < data_array.length; i++) {
        if (data_array[i][0] == end_rev) {
            center = i;
            break;
        }
    }
    console.assert(center != -1, "Center was not found");
    var smaller = $("#graph_range").val();
    var total = data_array.length;
    var to_draw = total - smaller;
    var upper = data_array.length;
    var lower = 0;
    if (center - (to_draw/2) > 0) {
        lower = center - (to_draw/2);
    }
    if (center + (to_draw/2) < total) {
        upper = center + (to_draw/2);
    }
        
    data_array = data_array.slice(lower, upper);

    if (normalize) {
        console.log(data_array);
        return normalize_data(data_array);
    } else {
        return data_array;
    }
}

function normalize_data(data_array) {
    var new_data = []

    
    for (var i = 0; i < data_array.length; i++) {
        new_data[i] = jQuery.extend({}, data_array[i]);
        new_data[i][1] = data_array[i][1] / data_array[0][1];
    }
    return new_data;
    
}

function make_graph_point_entry(data, color, regression) {
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
            entry["points"]["symbol"] = "cross";
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
                   "#1f78b4",
                   "#33a02c",
                   "#e31a1c",
                   "#ff7f00",
                   "#6a3d9a",
                   "#a6cee3",
                   "#b2df8a",
                   "#fb9a99",
                   "#fdbf6f",
                   "#cab2d6"]

function new_graph_data_callback(data, index) {
    data_cache[index] = data;
    update_graph();
}

function get_regression_id() {
    var path = window.location.pathname.split("/");
    if (path[path.length - 2] == "regressions") {
        return parseInt(path[path.length - 1]);
    } else {
        return null;
    }
}



function new_graph_regression_callback(data, index) {
    $.each(data, function (i, d) {

        if (get_regression_id() != null) {
            if (get_regression_id() == d['id'] || d['state'] == 21) {
                return;
            }
        }
        if ( ! (regression_cache[index])) {
            regression_cache[index] = [];
        }
        metadata = {'label': d['end_point'][0],
                    'title': d['title'],
                    'link': get_regression_url(db_name, test_suite_name, d['id']),
                    'state': STATE_NAMES[d['state']]}
        regression_cache[index].push([parseInt(d['end_point'][0]), d['end_point'][1],metadata]);
    });
    update_graph();
}


NOT_DRAWING = '<div class="alert alert-success" role="alert">' +
            'Too many to graph.<a href="#" class="close" data-dismiss="alert" aria-label="close">×</a>' + 
                        '</div>';
function update_graph() {
    var to_draw = [];
    var starts = [];
    var ends = [];
    // Data.
    for ( var i = 0; i < changes.length; i++) {
            
            if (is_checked[i] && data_cache[i]) {
                    starts.push(changes[i].start);
                    ends.push(changes[i].end);
                    var color = color_codes[i % color_codes.length];
                    var data = try_normal(data_cache[i], changes[i].end);

                    to_draw.push(make_graph_point_entry(data, color, false));
                    to_draw.push({"color": color, "data": data});
                
            }
    }
    // Regressions.
    for ( var i = 0; i < changes.length; i++) {
            
            if (is_checked[i] && data_cache[i]) {
                    if (regression_cache[i]) {
                        var regressions = try_normal(regression_cache[i], changes[i].end);
                        to_draw.push(make_graph_point_entry(regressions, color, true));
                    }
                
            }
    }
    var lowest_rev = Math.min.apply(Math, starts);
    var highest_rev = Math.max.apply(Math, ends);
    console.log(to_draw);
    init(to_draw, lowest_rev, highest_rev);    
}

// To be called by main page. It will fetch data and make graph ready.
function add_data_to_graph(URL, index) {
    var current_to_draw = is_checked.filter(function(x){ return x; }).length
    if (current_to_draw > MAX_TO_DRAW) {
        $('#errors').empty().prepend(NOT_DRAWING);
        is_checked[index] = true;
        return;
    }
    $.getJSON(get_api_url("graph", db_name, test_suite_name, URL), function(data) {
        new_graph_data_callback(data, index);
        });
    $.getJSON(get_api_url("regression", db_name, test_suite_name, URL), function(data) {
        new_graph_regression_callback(data, index);
        });
    is_checked[index] = true;
}

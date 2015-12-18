// Keep the graph data we download.
// Each element is a list of graph data points.
var data_cache = [];
var is_checked = []; // The current list of lines to plot.
var normalize = false;
var MAX_TO_DRAW = 25;

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

function make_graph_point_entry(data, color) {
    var entry = {"color": color,
                 "data": data,
                 "lines": {"show": false},
                 "points": {"fill": true,
                            "radius": 0.25,
                            "show": true
                           }
                };
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
                   "#F15854"]

function new_graph_data_callback(data, index) {
    data_cache[index] = data;
    update_graph();
}

NOT_DRAWING = '<div class="alert alert-success" role="alert">' +
            'Too many to graph.<a href="#" class="close" data-dismiss="alert" aria-label="close">×</a>' + 
                        '</div>';
function update_graph() {
    var to_draw = [];
    var starts = [];
    var ends = [];
    for ( var i = 0; i < changes.length; i++) {
            
            if (is_checked[i] && data_cache[i]) {
                    starts.push(changes[i].start);
                    ends.push(changes[i].end);
                    var color = color_codes[i % color_codes.length];
                    var data = try_normal(data_cache[i], changes[i].end);
                    to_draw.push(make_graph_point_entry(data, color));
                    to_draw.push({"color": color, "data": data});
            }
    }
    var lowest_rev = Math.min.apply(Math, starts);
    var highest_rev = Math.max.apply(Math, ends);
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
    $.getJSON(URL, function(data) {
        new_graph_data_callback(data, index);
        });
    is_checked[index] = true;
}

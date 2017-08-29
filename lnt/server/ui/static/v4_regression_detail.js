function clear_checks() {
     $('input:checkbox').removeAttr('checked');
     $('input:checkbox').trigger('change');
}

function all_checks() {
     $('input:checkbox').prop('checked','checked');
     $('input:checkbox').trigger('change');
}

function show_all() {
    dt.page.len(-1).draw();
}

function register_checkboxes() {
    $(':checkbox').change(function(){
          var c = this.checked
          var id = this.id;
          var index = id.split("-")[1];
          if (c) {
              var color = color_codes[index % color_codes.length];
              var prev_cell = $(this).closest('td').prev();
              prev_cell.css("background-color", color);
              add_data_to_graph(changes[index]["url"], index, max_samples);
          } else {
              is_checked[index] = false;
              var prev_cell = $(this).closest('td').prev();
              prev_cell.css("background-color", "transparent");
              update_graph();
          }

      });
    $(':checkbox').css("-webkit-transform", "scale(2)");
  }
function update_order_summary() {
    var start_orders = $(".change-row").map(function () {
        return parseInt($(this).data('order-start'));
    });
    var end_orders = $(".change-row").map(function () {
        return parseInt($(this).data('order-end'));
    });

    var min_order = Math.min.apply(Math, start_orders);
    var min_order_end = Math.min.apply(Math, end_orders);
    var max_order = Math.max.apply(Math, end_orders);
    var max_order_start = Math.max.apply(Math, start_orders);

    var times = $(".reltime").map(function () {
        return Date.parse($(this).data('time'));
    });
    var min_time = Math.min.apply(Math, times);

    // Now print all these things.
    var SIDE_BAR = '#side-bar'
    $(SIDE_BAR).append("<h3>Summary</h3><br/>")

    $(SIDE_BAR).append("<h4>Found</h4>");
    var change = " changes.";
    if (start_orders.length == 1) {
            change = " change."
    }
    $(SIDE_BAR).append(start_orders.length + change + "<br/>");

    $(SIDE_BAR).append($.format.prettyDate(new Date(min_time).toISOString()));
    $(SIDE_BAR).append(".<br/>");

    $(SIDE_BAR).append(new Date(min_time).toLocaleString());
    $(SIDE_BAR).append(".<br/>");
    $(SIDE_BAR).append("<h4>Orders</h4>");

    $(SIDE_BAR).append("<b>Union (" + (max_order - min_order) + " commits):</b><br/>");
    $(SIDE_BAR).append("<b>Min Order:</b> " + min_order + "<br/>");
    $(SIDE_BAR).append("<b>Max Order:</b> " + max_order + "<br/><br/>");

    var intersection_size = min_order_end - max_order_start;
    if (intersection_size > 0) {
        $(SIDE_BAR).append("<b>Intersection ("+ intersection_size +"): </b><br/>");
        $(SIDE_BAR).append("<b>Min Order:</b> " + max_order_start + "<br/>");
        $(SIDE_BAR).append("<b>Max Order:</b> " + min_order_end + "<br/><br/>");
    } else {
        $(SIDE_BAR).append("<b>No intersection</b><br/>");
    }

     $(SIDE_BAR).append("<br/><b><a href=\"?limit=1000\">More data</a></b><br/>");
     $(SIDE_BAR).append("<b><a href=\"?limit=0\">All data</a></b><br/>");
}

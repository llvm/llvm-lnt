// Register our initialization function.
window.onload = function() { init(); };

var g = {};

// These values are set up by the template.
g.config = g.all_orders = g.all_machines = g.save_url = null;

// Save the current configuration.
function save_config() {
  $.post(g.save_url, { 'config' : JSON.stringify(g.config) },
         function (data) {});
}

// Initialization function.
function init() {
  // Initialize some globals.
  g.selected_order = null;
  g.selected_order_index = null;

  // Initialize the "report order" list.
  var order_list = $('#report-order-list');
  order_list.empty();
  g.list_items = [];
  for (var i = 0; i != g.config.orders.length; ++i) {
    var order = g.config.orders[i];
    var name = order[0];
    var item = $('<button class="btn" style="width:90%;" ></button>');
    g.list_items.push(item);

    // Add the item contents.
    item.append(name);

    // Add a click event handler to select this item.
    item.click(function(index) {
      return function() { select_order(index); }; }(i));

    order_list.append(item);
  }

  // Initialize the selected order items.
  select_order(0);

  // Initialize the machines list.
  var machines = $('#report-machines');
  machines.empty();
  var machine_select = $('<select multiple="multiple"  style="width:300px;" size=20></select>');
  for (var j = 0; j != g.all_machines.length; ++j) {
    var selected_str = '';
    if ($.inArray(g.all_machines[j], g.config.machine_names) != -1)
      selected_str = ' selected';
    machine_select.append('<option value="' + j.toString() + '"' +
                                 selected_str + '>' +
                        g.all_machines[j] +
                        '</option>');
  }
  machine_select.appendTo(machines);
  machine_select.change(function() { update_machine_items(machine_select[0]); });
}

// Add a new report order entry.
function add_order() {
  var order = ['(New Order)', []];
  g.config.orders.push(order);
  init();
}

// Delete a report order entry.
function delete_order(index) {
  g.config.orders.splice(index, 1);
  init();
}

// Update the selected order name.
function update_selected_order_name(name_elt) {
  g.selected_order[0] = name_elt.value;

  var item = g.list_items[g.selected_order_index];
  item.empty();
  item.append(g.selected_order[0]);
}

// Update the selected orders for the active items.
function update_selected_order_items(select_elt) {
  g.selected_order[1] = [];
  for (var i = 0; i != select_elt.options.length; ++i) {
    var option = select_elt.options[i];
    if (option.selected)
      g.selected_order[1].push(g.all_orders[option.value]);
  }
}

// Update the machine list.
function update_machine_items(select_elt) {
  // We don't support a UI for machine patterns yet.
  g.config.machine_patterns = [];

  g.config.machine_names = [];
  for (var i = 0; i != select_elt.options.length; ++i) {
    var option = select_elt.options[i];
    if (option.selected)
      g.config.machine_names.push(g.all_machines[option.value]);
  }
} s

// Select a report order entry to edit.
function select_order(index) {
  g.selected_order_index = index;
  g.selected_order = g.config.orders[index];

  var elt = $('#report-order-items');
  elt.empty();

  var name_elt = $('<input type="text" value="' + g.selected_order[0] + '">');
  name_elt.appendTo(elt);
  name_elt.change(function() { update_selected_order_name(name_elt[0]); });

  elt.append('<br>');
  var order_select = $('<select multiple="multiple"  style="width:300px;" size=20></select>');
  for (var i = 0; i != g.all_orders.length; ++i) {
    var selected_str = '';
    if ($.inArray(g.all_orders[i], g.selected_order[1]) != -1)
      selected_str = ' selected';
    order_select.append('<option value="' + i.toString() + '"' +
                                 selected_str + '>' +
                        g.all_orders[i] +
                        '</option>');
  }
  order_select.appendTo(elt);
  order_select.change(function() {
      update_selected_order_items(order_select[0]);
    });

  elt.append('<br>');
  
  var del_button = $('<input type="button" value="Delete Order">');
  del_button.click(function() { delete_order(index); });
  del_button.appendTo(elt);
}
